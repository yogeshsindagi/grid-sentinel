"""
backend/ml_model.py
Loads pre-trained XGBoost model from backend/model/ and implements predictions for:
1. Clearance time (resolution minutes) - XGBoost model inference with OHE features.
2. Congestion Confidence Score (P_event) - Probability indicator.
3. Estimated Time to Cross (ETC) - Delay in minutes.
4. Secondary Bottleneck Propagation Risk - Gridlock threat level.
5. Logistical Resource Index - Traffic officers, barricades, cones, VMS settings.
"""

import pickle
import json
import numpy as np
import pandas as pd
import os
import warnings
import datetime
from sqlalchemy.orm import Session
from database import Event

warnings.filterwarnings("ignore", category=UserWarning)

# ── Constants ─────────────────────────────────────────────────────────────────
ACUTE_EVENTS = ['vehicle_breakdown', 'accident', 'water_logging', 'tree_fall']
NON_CORRIDORS = ['Non-corridor', 'Unknown', 'nan']

HIGH_CAUSE_NON_CORRIDOR = [
    'debris', 'water_logging', 'construction', 'road_conditions',
    'accident', 'congestion', 'vehicle_breakdown', 'vip_movement'
]

CHRONIC_MEDIANS = {
    'debris'         : 97302.0,
    'pot_holes'      : 35516.0,
    'road_conditions': 25888.0,
    'construction'   : 13662.0,
    'others'         : 12511.0,
    'congestion'     : 74.0,
    'fog_visibility' : 60.0,
    'public_event'   : 180.0,
    'vip_movement'   : 120.0,
    'procession'     : 240.0,
    'protest'        : 300.0,
}

_BASE_RADIUS = {
    'vehicle_breakdown': 300, 'accident': 500, 'water_logging': 800,
    'tree_fall': 400, 'construction': 600, 'road_conditions': 500,
    'debris': 400, 'congestion': 700, 'pot_holes': 200,
    'public_event': 1000, 'vip_movement': 1500,
    'procession': 1200, 'protest': 1000, 'others': 300,
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, 'model')

# ── In-Memory Model Cache ─────────────────────────────────────────────────────
_xgb_reg = None
_features_ohe = None
_le_dict = None
_model_type = None
_is_loaded = False

def load_models_sync():
    """Synchronous model loader called on worker startup."""
    global _xgb_reg, _features_ohe, _le_dict, _model_type, _is_loaded
    if _is_loaded:
        return

    reg_path = os.path.join(MODEL_DIR, 'resolution_regressor.pkl')
    le_path  = os.path.join(MODEL_DIR, 'label_encoders.pkl')
    feat_path = os.path.join(MODEL_DIR, 'features.json')

    # Verify files exist
    if not (os.path.exists(reg_path) and os.path.exists(feat_path)):
        print("[WARN] Pre-trained model files not found in backend/model/. Heuristic fallbacks will be used.")
        _is_loaded = True
        return

    try:
        # Load regressor
        with open(reg_path, 'rb') as f:
            _xgb_reg = pickle.load(f)

        # Load OHE Features list
        with open(feat_path, 'r') as f:
            _features_ohe = json.load(f)

        if any('event_cause_' in str(feat) for feat in _features_ohe):
            _model_type = 'ohe'
            print(f"[OK] OHE XGBoost Model Loaded - {len(_features_ohe)} features.")
        else:
            _model_type = 'label_encoder'
            if os.path.exists(le_path):
                with open(le_path, 'rb') as f:
                    _le_dict = pickle.load(f)
            print(f"[OK] LabelEncoder XGBoost Model Loaded.")
            
        _is_loaded = True
    except Exception as e:
        print(f"[WARN] Error loading XGBoost model: {e}. Heuristic fallbacks active.")
        _is_loaded = True

# ── Feature Predictions ────────────────────────────────────────────────────────

def assign_priority(corridor: str, event_cause: str) -> str:
    c_str = str(corridor).strip()
    cause_str = str(event_cause).lower().strip()
    if c_str not in NON_CORRIDORS:
        return 'High'
    elif cause_str in HIGH_CAUSE_NON_CORRIDOR:
        return 'Medium'
    return 'Low'

def calculate_impact_radius(event_cause: str, resolution_mins: float) -> int:
    def _mult(m):
        if m <= 15:    return 1.0
        elif m <= 30:  return 1.3
        elif m <= 60:  return 1.7
        elif m <= 120: return 2.2
        elif m <= 240: return 2.8
        return 3.5
    base = _BASE_RADIUS.get(str(event_cause).lower().strip(), 300)
    return min(int(base * _mult(resolution_mins)), 3000)

def get_severity_label(radius_m: int) -> str:
    if radius_m >= 2000:   return 'Severe Gridlock'
    elif radius_m >= 1000: return 'High Impact'
    elif radius_m >= 500:  return 'Medium Delay'
    return 'Localized Delay'

def get_severity_color(radius_m: int) -> str:
    if radius_m >= 2000:   return '#EF4444' # Tailwind Red
    elif radius_m >= 1000: return '#F97316' # Tailwind Orange
    elif radius_m >= 500:  return '#EAB308' # Tailwind Yellow
    return '#10B981' # Tailwind Green

def predict_clearance_time(event_cause: str, corridor: str, hour: int, is_weekend: bool, veh_type: str = 'unknown', requires_road_closure: bool = False) -> float:
    """Predicts clearance time in minutes using XGBoost with fallback to medians."""
    load_models_sync()
    event_cause = str(event_cause).lower().strip()
    veh_type = str(veh_type).lower().strip()
    is_weekend_val = int(is_weekend)
    
    # Heuristic default
    default_mins = CHRONIC_MEDIANS.get(event_cause, 60.0)
    
    if event_cause not in ACUTE_EVENTS:
        # Chronic events use historical median baselines
        return default_mins
        
    if _xgb_reg is None or _model_type is None:
        return default_mins

    try:
        month = datetime.datetime.now().month
        is_rush = 1 if (7 <= hour <= 10) or (17 <= hour <= 21) else 0
        is_night = 1 if hour >= 22 or hour <= 5 else 0
        
        if _model_type == 'ohe' and _features_ohe is not None:
            hour_sin = np.sin(2 * np.pi * hour / 24)
            hour_cos = np.cos(2 * np.pi * hour / 24)
            month_sin = np.sin(2 * np.pi * month / 12)
            month_cos = np.cos(2 * np.pi * month / 12)

            input_dict = {col: 0.0 for col in _features_ohe}
            
            # Map standard features
            mapping = {
                'requires_road_closure': float(requires_road_closure),
                'is_weekend': float(is_weekend_val),
                'is_rush_hour': float(is_rush),
                'is_night': float(is_night),
                'hour_sin': hour_sin,
                'hour_cos': hour_cos,
                'month_sin': month_sin,
                'month_cos': month_cos
            }
            for k, v in mapping.items():
                if k in input_dict:
                    input_dict[k] = v

            # Map one-hot encoded categories
            for prefix, val in [
                ('event_cause_', event_cause),
                ('veh_type_', veh_type),
                ('zone_', 'Unknown')
            ]:
                key = f"{prefix}{val}"
                if key in input_dict:
                    input_dict[key] = 1.0
                    
            df_in = pd.DataFrame([input_dict])[_features_ohe]
            pred_log = _xgb_reg.predict(df_in)[0]
            pred_mins = float(np.expm1(pred_log))
            return max(round(pred_mins, 1), 5.0)

        elif _model_type == 'label_encoder' and _le_dict is not None:
            REG_FEATURES = [
                'event_cause', 'requires_road_closure', 'hour', 'month',
                'is_weekend', 'is_rush_hour', 'is_night', 'veh_type'
            ]
            row = pd.DataFrame([{
                'event_cause': event_cause,
                'requires_road_closure': int(requires_road_closure),
                'hour': hour,
                'month': month,
                'is_weekend': is_weekend_val,
                'is_rush_hour': is_rush,
                'is_night': is_night,
                'veh_type': veh_type
            }])
            
            for col in ['event_cause', 'veh_type']:
                if col in _le_dict:
                    le = _le_dict[col]
                    val = str(row[col].iloc[0])
                    row[col] = le.transform([val])[0] if val in le.classes_ else 0
                    
            pred_log = _xgb_reg.predict(row[REG_FEATURES])[0]
            pred_mins = float(np.expm1(pred_log))
            return max(round(pred_mins, 1), 5.0)
            
    except Exception as e:
        print(f"[WARN] Inference prediction error: {e}. Falling back to defaults.")
        
    return default_mins

def predict_congestion_score(event_cause: str, corridor: str, hour: int, requires_road_closure: bool) -> float:
    """Predicts event-driven congestion confidence score P_event (0 to 100%)."""
    base_scores = {
        'accident': 85.0,
        'water_logging': 90.0,
        'vehicle_breakdown': 70.0,
        'tree_fall': 75.0,
        'construction': 65.0,
        'congestion': 95.0,
        'pot_holes': 40.0,
        'road_conditions': 50.0,
        'public_event': 80.0,
        'vip_movement': 90.0,
        'protest': 85.0,
        'others': 45.0
    }
    
    score = base_scores.get(str(event_cause).lower().strip(), 50.0)
    
    # Adjust for corridor vs non-corridor
    if str(corridor).strip() not in NON_CORRIDORS:
        score += 10.0
    else:
        score -= 10.0
        
    # Adjust for rush hour
    is_rush = (7 <= hour <= 10) or (17 <= hour <= 21)
    if is_rush:
        score += 10.0
    else:
        score -= 5.0
        
    # Adjust for road closure
    if requires_road_closure:
        score += 15.0
        
    return min(max(round(score, 1), 10.0), 100.0)

def predict_etc(event_cause: str, severity_label: str) -> float:
    """Predicts Estimated Time to Cross (ETC) in minutes."""
    base_delays = {
        'accident': 12.0,
        'water_logging': 20.0,
        'vehicle_breakdown': 6.0,
        'tree_fall': 10.0,
        'construction': 8.0,
        'congestion': 15.0,
        'pot_holes': 3.0,
        'road_conditions': 4.0,
        'public_event': 18.0,
        'vip_movement': 22.0,
        'protest': 18.0,
        'others': 3.0
    }
    
    base = base_delays.get(str(event_cause).lower().strip(), 5.0)
    
    multipliers = {
        'Severe Gridlock': 2.5,
        'High Impact': 1.8,
        'Medium Delay': 1.2,
        'Localized Delay': 0.8
    }
    
    mult = multipliers.get(severity_label, 1.0)
    return round(base * mult, 1)

def predict_propagation_risk(corridor: str, requires_road_closure: bool, priority: str) -> str:
    """Predicts secondary bottleneck propagation risk (Low/Medium/High)."""
    is_corridor = str(corridor).strip() not in NON_CORRIDORS
    
    if is_corridor and requires_road_closure and priority == 'High':
        return 'High'
    elif is_corridor or requires_road_closure or priority == 'High':
        return 'Medium'
    return 'Low'

def predict_logistics(event_cause: str, priority: str, requires_road_closure: bool) -> dict:
    """Predicts logistical resources recommended."""
    cause_str = str(event_cause).lower().strip()
    
    # Calculate recommended police officers
    base_officers = 1
    if priority == 'High':
        base_officers = 3
    elif priority == 'Medium':
        base_officers = 2
        
    if requires_road_closure:
        base_officers += 2
        
    if cause_str in ['accident', 'water_logging', 'vip_movement', 'protest']:
        base_officers += 1
        
    # Calculate recommended barricades
    base_barricades = 0
    if requires_road_closure:
        base_barricades = 12
    elif priority == 'High':
        base_barricades = 4
    elif priority == 'Medium':
        base_barricades = 2
        
    if cause_str == 'construction':
        base_barricades += 4
    elif cause_str == 'water_logging':
        base_barricades += 6
        
    # Calculate recommended cones
    base_cones = 4
    if priority == 'High':
        base_cones = 10
    elif priority == 'Medium':
        base_cones = 6
        
    return {
        'police_officers': int(base_officers),
        'barricades': int(base_barricades),
        'traffic_cones': int(base_cones),
        'vms_board_active': requires_road_closure or priority == 'High'
    }

def get_complete_prediction(event_cause: str, corridor: str, hour: int, is_weekend: bool, veh_type: str = 'unknown', requires_road_closure: bool = False) -> dict:
    """Combines all predictors to return the full operational impact matrix."""
    res_mins = predict_clearance_time(event_cause, corridor, hour, is_weekend, veh_type, requires_road_closure)
    priority = assign_priority(corridor, event_cause)
    radius = calculate_impact_radius(event_cause, res_mins)
    severity = get_severity_label(radius)
    color = get_severity_color(radius)
    
    p_event = predict_congestion_score(event_cause, corridor, hour, requires_road_closure)
    etc_mins = predict_etc(event_cause, severity)
    propagation = predict_propagation_risk(corridor, requires_road_closure, priority)
    logistics = predict_logistics(event_cause, priority, requires_road_closure)
    
    return {
        'event_cause': event_cause,
        'corridor': corridor,
        'priority': priority,
        'resolution_mins': round(res_mins, 1),
        'resolution_hours': round(res_mins / 60.0, 1),
        'impact_radius_m': radius,
        'severity_label': severity,
        'map_color': color,
        'congestion_confidence_pct': p_event,
        'etc_mins': etc_mins,
        'propagation_risk': propagation,
        'logistics': logistics,
        'is_acute': event_cause in ACUTE_EVENTS
    }
