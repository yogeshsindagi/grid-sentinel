"""
backend/main.py
FastAPI Core Web Server.
Exposes REST endpoints for authentication, incidents, predictions, routing, traffic, and analytics.
"""

from fastapi import FastAPI, Depends, HTTPException, status, Body, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from contextlib import asynccontextmanager
import asyncio
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy.orm import Session
from sqlalchemy import func, text
import datetime
import json
import jwt
import math
import random
import requests as http_requests
from typing import List, Optional

from .config import (
    AZURE_API_KEY, JWT_SECRET, JWT_ALGORITHM, ACCESS_TOKEN_EXPIRE_MINUTES,
    GOOGLE_CLIENT_ID, ADMIN_USERNAME, ADMIN_PASSWORD, TOMTOM_API_KEY
)
from .database import init_db, get_db, User, Report, Event, Setting, is_sqlite, SessionLocal
from .ml_model import load_models_sync, get_complete_prediction, calculate_impact_radius
from .routing import get_routing_with_detours, get_route, haversine_distance
from .ai_agent import parse_report_with_ai, run_chat_agent, generate_suggestions_with_ai

security = HTTPBearer(auto_error=False)

# ── Serialization Helpers ─────────────────────────────────────────────────────

def serialize_user(user):
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "google_id": user.google_id,
        "profile_picture": user.profile_picture,
        "is_authorized": user.is_authorized
    }

def serialize_event(event):
    return {
        "id": event.id,
        "creator_id": event.creator_id,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "address": event.address,
        "event_cause": event.event_cause,
        "requires_road_closure": event.requires_road_closure,
        "zone_type": event.zone_type,
        "priority": event.priority,
        "veh_type": event.veh_type,
        "start_datetime": event.start_datetime.isoformat() if event.start_datetime else None,
        "initial_clearance_time_mins": event.initial_clearance_time_mins,
        "current_clearance_time_mins": event.current_clearance_time_mins,
        "status": event.status,
        "resolved_at": event.resolved_at.isoformat() if event.resolved_at else None,
        "description": event.description,
        "corridor": event.corridor,
        "endlatitude": event.endlatitude,
        "endlongitude": event.endlongitude,
        "officer_suggestions": event.officer_suggestions,
        "traveler_suggestions": event.traveler_suggestions,
        "detour_route_geojson": event.detour_route_geojson
    }

def serialize_report(report):
    return {
        "id": report.id,
        "user_id": report.user_id,
        "latitude": report.latitude,
        "longitude": report.longitude,
        "address": report.address,
        "event_cause": report.event_cause,
        "description": report.description,
        "status": report.status,
        "created_at": report.created_at.isoformat() if report.created_at else None
    }

# ── Auth Helpers ──────────────────────────────────────────────────────────────

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security), db: Session = Depends(get_db)):
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        email = payload.get("email")
        if not email:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token: missing email")
        user = db.query(User).filter(User.email == email).first()
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {str(e)}")

def get_optional_user(credentials: HTTPAuthorizationCredentials = Depends(security), db: Session = Depends(get_db)):
    """Returns user if token present, None otherwise."""
    if not credentials:
        return None
    try:
        return get_current_user(credentials, db)
    except HTTPException:
        return None

def require_admin(current_user: User = Depends(get_current_user)):
    if current_user.role != "Admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required")
    return current_user

def check_service_permission(service_key: str, role: str, db: Session) -> bool:
    if role == "Admin":
        return True
        
    master_key = {
        "chatbot": "is_chatbot_active",
        "routing": "is_routing_active",
        "overlay": "is_traffic_overlay_active",
        "density": "is_traffic_density_active"
    }.get(service_key, f"is_{service_key}_active")
    
    master_setting = db.query(Setting).filter(Setting.key == master_key).first()
    if master_setting and master_setting.value.lower() == "false":
        return False
        
    mode_custom_setting = db.query(Setting).filter(Setting.key == f"{service_key}_mode_custom").first()
    is_custom = mode_custom_setting and mode_custom_setting.value.lower() == "true"
    
    if is_custom:
        role_setting = db.query(Setting).filter(Setting.key == f"{service_key}_roles_{role}").first()
        return role_setting is None or role_setting.value.lower() in ["true", "on", "limited"]
        
    mode_all_setting = db.query(Setting).filter(Setting.key == f"{service_key}_mode_all").first()
    return mode_all_setting is None or mode_all_setting.value.lower() in ["true", "on", "limited"]

def require_officer_or_admin(current_user: User = Depends(get_current_user)):
    if current_user.role not in ["Officer", "Admin"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Officer or Admin privileges required")
    return current_user

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.datetime.utcnow() + datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_google_token(id_token: str) -> dict:
    """Verify Google ID token via Google's tokeninfo endpoint."""
    try:
        resp = http_requests.get(
            f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}",
            timeout=10
        )
        if resp.status_code == 200:
            data = resp.json()
            # Verify the token was intended for our app
            if GOOGLE_CLIENT_ID and data.get("aud") != GOOGLE_CLIENT_ID:
                raise HTTPException(status_code=401, detail="Token not intended for this application")
            return data
        raise HTTPException(status_code=401, detail=f"Google token verification failed: {resp.text}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Could not verify Google token: {str(e)}")

def update_dynamic_clearance(event: Event):
    """Dynamically compute remaining clearance time."""
    if event.status == "active" and event.start_datetime:
        now = datetime.datetime.utcnow()
        diff_mins = int((now - event.start_datetime).total_seconds() // 60)
        event.current_clearance_time_mins = max(0, event.initial_clearance_time_mins - diff_mins)
    return event


# ── Lifespan Context Manager ─────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[DB] Initializing database schema...")
    try:
        init_db()
        print("[OK] Database schema verified.")
        db = SessionLocal()
        try:
            if db.query(User).count() == 0:
                print("[WARN] Database is empty. Seeding admin user and settings...")
                from .import_data import import_all
                import_all()
        finally:
            db.close()
    except Exception as e:
        print(f"[ERROR] Database initialization failed: {e}")

    print("[ML] Loading Machine Learning models in background...")
    loop = asyncio.get_running_loop()
    with ThreadPoolExecutor() as pool:
        await loop.run_in_executor(pool, load_models_sync)
    print("[OK] ML models loaded successfully.")
    yield

app = FastAPI(
    title="GridLock Sentinel API",
    description="AI-powered Civic Traffic Management & Routing System",
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ══════════════════════════════════════════════════════════════════════════════
# AUTHENTICATION ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/auth/google")
def google_login(payload: dict = Body(...), db: Session = Depends(get_db)):
    """Google OAuth2 login. Verifies Google ID token, creates/returns user."""
    credential = payload.get("credential")
    if not credential:
        raise HTTPException(status_code=400, detail="Google credential is required")
    
    google_data = verify_google_token(credential)
    email = google_data.get("email")
    name = google_data.get("name", "User")
    google_id = google_data.get("sub")
    picture = google_data.get("picture", "")
    
    if not email:
        raise HTTPException(status_code=400, detail="Google token does not contain email")
    
    # Check if user exists by google_id first, then by email
    user = None
    if google_id:
        user = db.query(User).filter(User.google_id == google_id).first()
    if not user:
        user = db.query(User).filter(User.email == email).first()
    
    if user:
        # Update profile info
        if google_id and not user.google_id:
            user.google_id = google_id
        if picture:
            user.profile_picture = picture
        if name and name != "User":
            user.name = name
        db.commit()
        db.refresh(user)
    else:
        # Create new user as Commuter
        user = User(
            email=email,
            name=name,
            role="Commuter",
            is_authorized=False,
            google_id=google_id,
            profile_picture=picture
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    
    token = create_access_token({
        "id": user.id, "email": user.email, "role": user.role, "name": user.name
    })
    
    return {"token": token, "user": serialize_user(user)}

@app.post("/api/auth/admin-login")
def admin_login(payload: dict = Body(...), db: Session = Depends(get_db)):
    """Admin-only login via username/password. Hidden route."""
    email = payload.get("email", "")
    password = payload.get("password", "")
    
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password are required")
    
    if email != ADMIN_USERNAME or password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid admin credentials")
    
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(email=email, name="System Admin", role="Admin", is_authorized=True)
        db.add(user)
        db.commit()
        db.refresh(user)
    
    token = create_access_token({
        "id": user.id, "email": user.email, "role": user.role, "name": user.name
    })
    
    return {"token": token, "user": serialize_user(user)}

@app.post("/api/auth/demo")
def demo_login(payload: dict = Body(...), db: Session = Depends(get_db)):
    """Demo login to instantly switch roles without Google OAuth."""
    role = payload.get("role")
    if role not in ["Commuter", "Officer", "Admin"]:
        raise HTTPException(status_code=400, detail="Invalid demo role")
    
    email = f"demo_{role.lower()}@gridlock.sentinel"
    name = f"Demo {role}"
    
    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(
            email=email,
            name=name,
            role=role,
            is_authorized=role in ["Officer", "Admin"]
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        
    token = create_access_token({
        "id": user.id, "email": user.email, "role": user.role, "name": user.name
    })
    
    return {"token": token, "user": serialize_user(user)}

@app.get("/api/auth/me")
def get_me(current_user: User = Depends(get_current_user)):
    """Returns the current authenticated user."""
    return serialize_user(current_user)

# ══════════════════════════════════════════════════════════════════════════════
# USER MANAGEMENT (Admin Console)
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/users")
def get_all_users(db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    users = db.query(User).all()
    return [serialize_user(u) for u in users]

@app.put("/api/users/{user_id}/role")
def update_user_role(user_id: str, payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    role = payload.get("role")
    if role not in ["Commuter", "Officer", "Admin"]:
        raise HTTPException(status_code=400, detail="Invalid role. Must be Commuter, Officer, or Admin")
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot change your own role")
    
    user.role = role
    user.is_authorized = role in ["Officer", "Admin"]
    db.commit()
    db.refresh(user)
    return serialize_user(user)

# ══════════════════════════════════════════════════════════════════════════════
# SYSTEM SETTINGS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/settings")
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings_records = db.query(Setting).all()
    res = {}
    for s in settings_records:
        val = s.value.lower()
        if val in ["true", "false"]:
            res[s.key] = (val == "true")
        else:
            res[s.key] = s.value
    return res

@app.post("/api/settings")
def update_settings(payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    for k, v in payload.items():
        setting = db.query(Setting).filter(Setting.key == k).first()
        if isinstance(v, bool):
            val_str = "true" if v else "false"
        else:
            val_str = str(v)
        if setting:
            setting.value = val_str
        else:
            db.add(Setting(key=k, value=val_str))
    db.commit()
    return get_settings(db, current_user)

# ══════════════════════════════════════════════════════════════════════════════
# ML PREDICTION
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/predict")
def get_prediction(payload: dict = Body(...), current_user: User = Depends(get_current_user)):
    cause = payload.get("event_cause", "others")
    corridor = payload.get("corridor", "Non-corridor")
    hour = payload.get("hour", 12)
    is_weekend = payload.get("is_weekend", False)
    veh_type = payload.get("veh_type", "unknown")
    requires_road_closure = payload.get("requires_road_closure", False)
    try:
        return get_complete_prediction(cause, corridor, hour, is_weekend, veh_type, requires_road_closure)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")

# ══════════════════════════════════════════════════════════════════════════════
# REPORTS (Traveler Pings)
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/reports")
def get_reports(status: Optional[str] = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    query = db.query(Report)
    if status:
        query = query.filter(Report.status == status)
    reports = query.order_by(Report.created_at.desc()).all()
    return [serialize_report(r) for r in reports]

@app.post("/api/reports")
def create_report(payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    lat = payload.get("latitude")
    lon = payload.get("longitude")
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="Latitude and Longitude are required")
    
    report = Report(
        user_id=current_user.id,
        latitude=lat,
        longitude=lon,
        address=payload.get("address", "Bengaluru, Karnataka"),
        event_cause=payload.get("event_cause", "others"),
        description=payload.get("description", ""),
        status="pending"
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return serialize_report(report)

@app.post("/api/reports/{report_id}/status")
def update_report_status(report_id: str, payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(require_officer_or_admin)):
    status_val = payload.get("status")
    if status_val not in ["verified", "rejected"]:
        raise HTTPException(status_code=400, detail="Status must be 'verified' or 'rejected'")
    
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    report.status = status_val
    db.commit()
    db.refresh(report)
    return serialize_report(report)

def get_closed_route_geojson(start_lat, start_lon, end_lat, end_lon):
    if start_lat is not None and start_lon is not None and end_lat is not None and end_lon is not None:
        try:
            # Check if coords are numeric and not empty/zero
            s_lat = float(start_lat)
            s_lon = float(start_lon)
            e_lat = float(end_lat)
            e_lon = float(end_lon)
            if s_lat != 0 and s_lon != 0 and e_lat != 0 and e_lon != 0:
                route_res = get_route(s_lat, s_lon, e_lat, e_lon)
                if route_res.get("success"):
                    return {
                        "geometry": route_res["geometry"],
                        "distance_m": route_res["distance_m"],
                        "duration_sec": route_res["duration_sec"],
                        "duration_mins": round(route_res["duration_sec"] / 60.0, 1)
                    }
        except Exception as e:
            print(f"[WARN] Failed to get closed route segment: {e}")
    return None

@app.post("/api/reports/{report_id}/analyze")
def analyze_report(
    report_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_officer_or_admin)
):
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
        
    # Find all other pending reports within 500m radius AND same event category
    inferred_cause = report.event_cause or "others"
    all_pending = db.query(Report).filter(Report.status == "pending").all()
    supporting_reports = []
    for r in all_pending:
        dist = haversine_distance(report.latitude, report.longitude, r.latitude, r.longitude)
        if dist <= 500.0 and (r.event_cause or "others") == inferred_cause:
            supporting_reports.append(r)
            
    supporting_ids = [r.id for r in supporting_reports]
    
    # Combine descriptions from all supporting reports for richer context
    all_descriptions = [r.description for r in supporting_reports if r.description and r.description.strip()]
    combined_description = "; ".join(all_descriptions) if all_descriptions else (report.description or "")
    
    # Query live traffic density at exact coordinate
    congestion = 0.0
    if TOMTOM_API_KEY and TOMTOM_API_KEY != "YOUR_TOMTOM_API_KEY_HERE":
        try:
            url = "https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json"
            resp = http_requests.get(url, params={
                "point": f"{report.latitude},{report.longitude}",
                "key": TOMTOM_API_KEY,
                "unit": "KMPH"
            }, timeout=2.5)
            if resp.status_code == 200:
                flow_data = resp.json().get("flowSegmentData", {})
                free_flow = flow_data.get("freeFlowSpeed", 60)
                current_speed = flow_data.get("currentSpeed", 60)
                congestion = max(0.0, 1.0 - (current_speed / free_flow)) if free_flow > 0 else 0.0
        except Exception:
            pass
            
    # Fallback to simulated congestion if TomTom data was unavailable
    if congestion == 0.0:
        ist_hour = (datetime.datetime.utcnow().hour + 5) % 24
        is_rush = (7 <= ist_hour <= 10) or (17 <= ist_hour <= 21)
        congestion = random.uniform(0.5, 0.8) if is_rush else random.uniform(0.15, 0.4)
        
    # Calculate confidence score
    # Base is 30%
    # Each other pending report nearby adds 20% (up to 40%)
    # Congestion score adds up to 30%
    reports_contrib = min(40.0, max(0.0, len(supporting_ids) - 1) * 20.0)
    congestion_contrib = congestion * 30.0
    confidence_score = min(100.0, 30.0 + reports_contrib + congestion_contrib)
    
    # Verdict line
    if confidence_score >= 75.0:
        support_text = f"Highly Confirmed: {len(supporting_ids) - 1} nearby report(s) and heavy congestion ({int(congestion * 100)}%) strongly corroborate this incident."
    elif confidence_score >= 45.0:
        support_text = f"Moderately Confirmed: {len(supporting_ids) - 1} nearby report(s) and moderate congestion ({int(congestion * 100)}%) suggest a likely incident."
    else:
        support_text = f"Unconfirmed: No other nearby reports and low congestion ({int(congestion * 100)}%). Verify with caution."

    # Parse cause (already done above)
    
    # ML operational prediction parameters
    hour = (datetime.datetime.utcnow().hour + 5) % 24
    is_weekend = datetime.datetime.utcnow().weekday() >= 5
    requires_closure = False
    
    desc_lower = (report.description or "").lower()
    if any(k in desc_lower for k in ["blocked", "closed", "gridlock", "full lane", "cannot pass"]):
        requires_closure = True
    elif inferred_cause in ["accident", "protest", "vip_movement", "water_logging"]:
        requires_closure = True
        
    inferred_corridor = "Non-corridor"
    corridors = ["Mysore Road", "Bellary Road", "Tumkur Road", "Hosur Road", "Outer Ring Road", "Old Madras Road", "Magadi Road", "Sarjapur Road", "Bannerghatta Road"]
    search_text = (report.address or "") + " " + desc_lower
    for c in corridors:
        if c.lower() in search_text.lower():
            inferred_corridor = c
            break
            
    pred = get_complete_prediction(inferred_cause, inferred_corridor, hour, is_weekend, "unknown", requires_closure)
    
    # Fetch detour route passing through this point
    # We calculate the detour start and end coordinates dynamically from the impact radius
    h_rad = pred["impact_radius_m"]
    # 1.8x multiplier ensures detour start/end points are far enough out to bypass
    lat_delta = max((h_rad * 1.8) / 111000.0, 0.005)
    cos_lat = math.cos(math.radians(report.latitude))
    lng_delta = max((h_rad * 1.8) / (111000.0 * cos_lat), 0.005) if cos_lat > 0 else lat_delta

    start_lat = report.latitude - lat_delta
    start_lon = report.longitude - lng_delta
    end_lat = report.latitude + lat_delta
    end_lon = report.longitude + lng_delta
    
    incidents_list = [{
        "latitude": report.latitude,
        "longitude": report.longitude,
        "impact_radius_m": h_rad,
        "requires_road_closure": True,  # ALWAYS force True for suggestion detour preview
        "event_cause": inferred_cause
    }]
    
    routing_info = get_routing_with_detours(start_lat, start_lon, end_lat, end_lon, incidents_list)
    
    # Force the normal route to pass through the epicenter as a waypoint
    epicenter_lat = report.latitude
    epicenter_lon = report.longitude
    norm_res = get_route(start_lat, start_lon, end_lat, end_lon, waypoints=[(epicenter_lat, epicenter_lon)])
    if norm_res.get("success"):
        norm_data = {
            "geometry": norm_res["geometry"],
            "distance_m": norm_res["distance_m"],
            "duration_sec": norm_res["duration_sec"],
            "duration_mins": round(norm_res["duration_sec"] / 60.0, 1)
        }
    else:
        norm_data = routing_info.get("normal_route") or {
            "geometry": {"type": "LineString", "coordinates": []},
            "distance_m": 0,
            "duration_sec": 0,
            "duration_mins": 0
        }
        
    detour_desc = "Refer to the interactive MiniMap for the alternate rerouting path to bypass this event spot."
    detour_route_geojson = None
    
    if routing_info.get("intersects_hazard") and routing_info.get("detour_route"):
        det_data = routing_info["detour_route"]
        
        # Compare expected passing time without detour (normal route + estimated delay) vs detour route
        etc_mins = pred["etc_mins"]
        normal_with_delay = norm_data["duration_mins"] + etc_mins
        detour_mins = det_data["duration_mins"]
        savings = normal_with_delay - detour_mins
        
        if savings > 0:
            comparison_text = f"Taking the detour saves approx {round(savings, 1)} mins compared to staying on the normal route in traffic."
        else:
            comparison_text = f"Taking the detour adds {round(-savings, 1)} mins to base travel time, but bypasses the blocked epicenter completely."
            
        detour_desc = (
            f"Detour is active. "
            f"Normal Route (with traffic delay): {round(normal_with_delay, 1)} mins "
            f"(includes {etc_mins} mins delay). "
            f"Detour Route: {round(detour_mins, 1)} mins. "
            f"{comparison_text}"
        )
        
        detour_route_geojson = json.dumps({
            "success": True,
            "intersects_hazard": True,
            "incident_cause": inferred_cause,
            "normal_route": norm_data,
            "safe_route": det_data,
            "closed_route": None
        })
    else:
        # Fallback normal/safe routes
        direct_res = get_route(start_lat, start_lon, end_lat, end_lon)
        if direct_res.get("success"):
            safe_data = {
                "geometry": direct_res["geometry"],
                "distance_m": direct_res["distance_m"],
                "duration_sec": direct_res["duration_sec"],
                "duration_mins": round(direct_res["duration_sec"] / 60.0, 1)
            }
        else:
            safe_data = norm_data
            
        detour_route_geojson = json.dumps({
            "success": True,
            "intersects_hazard": False,
            "normal_route": norm_data,
            "safe_route": safe_data,
            "closed_route": None
        })
            
    police_officers = pred["logistics"]["police_officers"]
    barricades = pred["logistics"]["barricades"]
    cones = pred["logistics"]["traffic_cones"]
    vms_board = "Yes (Active Alert)" if pred["logistics"]["vms_board_active"] else "No (Passive monitoring)"
    
    # Build complete route info dict for suggestion agent
    route_info_dict = {
        "normal_route": norm_data,
        "safe_route": json.loads(detour_route_geojson)["safe_route"] if detour_route_geojson else norm_data,
        "closed_route": None
    }
    
    sug_res = generate_suggestions_with_ai(
        cause=inferred_cause,
        priority=pred["priority"],
        lat=report.latitude,
        lon=report.longitude,
        description=combined_description,
        requires_closure=requires_closure,
        pred_logistics=pred["logistics"],
        pred_metrics=pred,
        route_info=route_info_dict
    )
    immediate_action = sug_res["immediate_action"]
    tactical_instructions = sug_res["tactical_instructions"]
    markdown_content = sug_res["markdown_content"]
    
    # Custom commuter warning and action based on requires_closure
    cause_title = inferred_cause.replace('_', ' ').title()
    loc_name = report.address or 'reported location'
    if requires_closure:
        warning_msg = f"[ALERT] ROAD CLOSED: {cause_title} at {loc_name} requires full road closure."
        commuter_action = "Road is closed at the epicenter. Detour is active; follow green signs on the MiniMap to bypass."
    else:
        warning_msg = f"[ALERT] Traffic Slowdown: {cause_title} ahead at {loc_name}."
        commuter_action = "Road remains open. Proceed with caution; watch for slow-moving traffic."

    parsed_fields = {
        "event_cause": inferred_cause,
        "latitude": report.latitude,
        "longitude": report.longitude,
        "address": report.address or "Bengaluru, Karnataka",
        "requires_road_closure": requires_closure,
        "priority": pred["priority"],
        "veh_type": "unknown",
        "corridor": inferred_corridor,
        "initial_clearance_time_mins": int(pred["resolution_mins"]),
        "description": combined_description or sug_res.get("description") or f"Auto-verified report of {inferred_cause.replace('_', ' ')}.",
        "endlatitude": None,
        "endlongitude": None
    }
    
    officer_suggestions_dict = {
        "immediate_action": immediate_action,
        "logistics": pred["logistics"],
        "junction_deployment": [f"Epicenter point ({police_officers} officers recommended)"],
        "tactical_instructions": tactical_instructions
    }
    traveler_suggestions_dict = {
        "warning_message": warning_msg,
        "eta_impact": f"Est. crossing time: {pred['etc_mins']} mins delay.",
        "detour_instructions": f"Detour advised. Impact radius: {pred['impact_radius_m']}m. {detour_desc}",
        "commuter_action": commuter_action
    }

    return {
        "id": report_id,
        "supporting_ids": supporting_ids,
        "confidence_score": confidence_score,
        "support_text": support_text,
        "parsed_fields": parsed_fields,
        "officer_suggestions": json.dumps(officer_suggestions_dict),
        "traveler_suggestions": json.dumps(traveler_suggestions_dict),
        "detour_route_geojson": detour_route_geojson,
        "markdown_content": markdown_content,
        "delay_mins": int(pred["etc_mins"]),
        "requires_road_closure": requires_closure
    }

@app.post("/api/reports/verify-bulk")
def verify_reports_bulk(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_officer_or_admin)
):
    ids = payload.get("ids", [])
    if not ids:
        return {"success": True, "count": 0}
        
    db.query(Report).filter(Report.id.in_(ids)).update(
        {"status": "verified"},
        synchronize_session=False
    )
    db.commit()
    return {"success": True, "count": len(ids)}

@app.post("/api/events/calculate-clearance")
def calculate_clearance(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_officer_or_admin)
):
    cause = payload.get("event_cause", "others")
    lat = payload.get("latitude")
    lon = payload.get("longitude")
    requires_road_closure = payload.get("requires_road_closure", False)
    veh_type = payload.get("veh_type", "unknown")
    address = payload.get("address", "")
    description = payload.get("description", "")
    
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="Latitude and Longitude are required")
        
    try:
        lat = float(lat)
        lon = float(lon)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Latitude or Longitude")
    
    inferred_corridor = "Non-corridor"
    corridors = ["Mysore Road", "Bellary Road", "Tumkur Road", "Hosur Road", "Outer Ring Road", "Old Madras Road", "Magadi Road", "Sarjapur Road", "Bannerghatta Road"]
    search_text = f"{address} {description}"
    for c in corridors:
        if c.lower() in search_text.lower():
            inferred_corridor = c
            break

    # Calculate hour and weekend status in IST (UTC+5:30)
    ist_time = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)
    hour = ist_time.hour
    is_weekend = ist_time.weekday() >= 5
    
    pred = get_complete_prediction(cause, inferred_corridor, hour, is_weekend, veh_type, requires_road_closure)
    
    import sys
    print("\n" + "="*50)
    print("      ML CLEARANCE TIME CALCULATION REQUEST")
    print("="*50)
    print(f"Timestamp (IST)   : {ist_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Event Cause       : {cause}")
    print(f"Latitude/Longitude: {lat}, {lon}")
    print(f"Road Closure      : {requires_road_closure}")
    print(f"Vehicle Type      : {veh_type}")
    print(f"Inferred Corridor : {inferred_corridor}")
    print(f"Hour (IST)        : {hour}")
    print(f"Is Weekend        : {is_weekend}")
    print("-"*50)
    print("                     OUTPUTS")
    print("-"*50)
    print(f"Predicted Clearance Time: {pred['resolution_mins']} mins")
    print(f"Estimated Time to Cross : {pred['etc_mins']} mins")
    print(f"Priority                : {pred['priority']}")
    print(f"Impact Radius           : {pred['impact_radius_m']}m")
    print(f"Propagation Risk        : {pred['propagation_risk']}")
    print(f"Logistics Recommendation: Officers: {pred['logistics']['police_officers']}, Barricades: {pred['logistics']['barricades']}, Cones: {pred['logistics']['traffic_cones']}")
    print("="*50 + "\n")
    sys.stdout.flush()

    return {
        "predicted_clearance_time_mins": int(pred["resolution_mins"]),
        "etc_mins": pred["etc_mins"],
        "priority": pred["priority"],
        "impact_radius_m": pred["impact_radius_m"],
        "propagation_risk": pred["propagation_risk"],
        "logistics": pred["logistics"]
    }

@app.post("/api/events/preview-suggestions")
def preview_suggestions(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_officer_or_admin)
):
    if not check_service_permission("ai_suggestion", current_user.role, db):
        raise HTTPException(status_code=403, detail="AI Suggestions service is disabled for your role")
    lat = payload.get("latitude")
    lon = payload.get("longitude")
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="Latitude and Longitude are required")
    
    try:
        lat = float(lat)
        lon = float(lon)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Latitude or Longitude")
        
    cause = payload.get("event_cause", "others")
    requires_closure = payload.get("requires_road_closure", False)
    priority = payload.get("priority", "Medium")
    veh_type = payload.get("veh_type", "unknown")
    resolution_mins = payload.get("initial_clearance_time_mins", 30)
    try:
        resolution_mins = int(resolution_mins)
    except ValueError:
        resolution_mins = 30
        
    address = payload.get("address", "Bengaluru, Karnataka")
    payload_end_lat = payload.get("endlatitude")
    payload_end_lon = payload.get("endlongitude")
    try:
        payload_end_lat = float(payload_end_lat) if payload_end_lat is not None and payload_end_lat != "" else None
    except (ValueError, TypeError):
        payload_end_lat = None
    try:
        payload_end_lon = float(payload_end_lon) if payload_end_lon is not None and payload_end_lon != "" else None
    except (ValueError, TypeError):
        payload_end_lon = None
        
    if requires_closure:
        if payload_end_lat is None or payload_end_lon is None:
            raise HTTPException(status_code=400, detail="End Latitude and End Longitude are mandatory when road closure is required")
    description = payload.get("description", "")

    # Use corridor from payload if provided by officer, else infer from text
    inferred_corridor = payload.get("corridor", "")
    if not inferred_corridor or inferred_corridor == "Non-corridor":
        corridors = ["Mysore Road", "Bellary Road", "Tumkur Road", "Hosur Road", "Outer Ring Road", "Old Madras Road", "Magadi Road", "Sarjapur Road", "Bannerghatta Road"]
        search_text = f"{address} {description}"
        inferred_corridor = "Non-corridor"
        for c in corridors:
            if c.lower() in search_text.lower():
                inferred_corridor = c
                break

    # Now query the ML model first
    pred = get_complete_prediction(cause, inferred_corridor, 12, False, veh_type, requires_closure)
    h_rad = pred["impact_radius_m"]
    
    # Use user-specified start and end coordinates for detour routing if available, otherwise fallback to defaults or delta offsets
    route_start_lat = payload.get("route_start_latitude")
    route_start_lon = payload.get("route_start_longitude")
    route_end_lat = payload.get("route_end_latitude")
    route_end_lon = payload.get("route_end_longitude")
    
    try:
        route_start_lat = float(route_start_lat) if route_start_lat is not None and route_start_lat != "" else None
        route_start_lon = float(route_start_lon) if route_start_lon is not None and route_start_lon != "" else None
        route_end_lat = float(route_end_lat) if route_end_lat is not None and route_end_lat != "" else None
        route_end_lon = float(route_end_lon) if route_end_lon is not None and route_end_lon != "" else None
    except (ValueError, TypeError):
        route_start_lat = route_start_lon = route_end_lat = route_end_lon = None

    if route_start_lat is None or route_start_lon is None:
        route_start_lat = lat
        route_start_lon = lon
    if route_end_lat is None or route_end_lon is None:
        route_end_lat = payload_end_lat if payload_end_lat is not None else lat
        route_end_lon = payload_end_lon if payload_end_lon is not None else lon

    # Fallback to delta offsets if we still don't have end coordinate
    if route_end_lat is None or route_end_lon is None:
        lat_delta = max((h_rad * 1.8) / 111000.0, 0.005)
        cos_lat = math.cos(math.radians(lat))
        lng_delta = max((h_rad * 1.8) / (111000.0 * cos_lat), 0.005) if cos_lat > 0 else lat_delta

        route_start_lat = lat - lat_delta
        route_start_lon = lon - lng_delta
        route_end_lat = lat + lat_delta
        route_end_lon = lon + lng_delta
    
    incidents_list = [{
        "latitude": lat,
        "longitude": lon,
        "endlatitude": payload_end_lat,
        "endlongitude": payload_end_lon,
        "impact_radius_m": h_rad,
        "requires_road_closure": True,  # ALWAYS force True for suggestion detour preview
        "event_cause": cause
    }]
    
    routing_info = get_routing_with_detours(route_start_lat, route_start_lon, route_end_lat, route_end_lon, incidents_list)
    
    # Force the normal route to pass through the epicenter as a waypoint
    waypoints = [(lat, lon)]
    if requires_closure and payload_end_lat is not None and payload_end_lon is not None:
        waypoints = [(lat, lon), (payload_end_lat, payload_end_lon)]
    norm_res = get_route(route_start_lat, route_start_lon, route_end_lat, route_end_lon, waypoints=waypoints)
    if norm_res.get("success"):
        norm_data = {
            "geometry": norm_res["geometry"],
            "distance_m": norm_res["distance_m"],
            "duration_sec": norm_res["duration_sec"],
            "duration_mins": round(norm_res["duration_sec"] / 60.0, 1)
        }
    else:
        norm_data = routing_info.get("normal_route") or {
            "geometry": {"type": "LineString", "coordinates": []},
            "distance_m": 0,
            "duration_sec": 0,
            "duration_mins": 0
        }
        
    # Already parsed end coordinates above
    closed_route = None
    if requires_closure and payload_end_lat is not None and payload_end_lon is not None:
        closed_route = get_closed_route_geojson(lat, lon, payload_end_lat, payload_end_lon)

    detour_desc = "Refer to the interactive MiniMap for the alternate rerouting path to bypass this event spot."
    detour_route_geojson = None
    if routing_info.get("intersects_hazard") and routing_info.get("detour_route"):
        det_data = routing_info["detour_route"]
        
        # Compare expected passing time without detour (normal route + estimated delay) vs detour route
        etc_mins = pred["etc_mins"]
        normal_with_delay = norm_data["duration_mins"] + etc_mins
        detour_mins = det_data["duration_mins"]
        savings = normal_with_delay - detour_mins
        
        if savings > 0:
            comparison_text = f"Taking the detour saves approx {round(savings, 1)} mins compared to staying on the normal route in traffic."
        else:
            comparison_text = f"Taking the detour adds {round(-savings, 1)} mins to base travel time, but bypasses the blocked epicenter completely."
            
        detour_desc = (
            f"Detour is active. "
            f"Normal Route (with traffic delay): {round(normal_with_delay, 1)} mins "
            f"(includes {etc_mins} mins delay). "
            f"Detour Route: {round(detour_mins, 1)} mins. "
            f"{comparison_text}"
        )
        
        detour_route_geojson = json.dumps({
            "success": True,
            "intersects_hazard": True,
            "incident_cause": cause,
            "normal_route": norm_data,
            "safe_route": det_data,
            "closed_route": closed_route
        })
    else:
        # Fallback normal/safe routes
        direct_res = get_route(route_start_lat, route_start_lon, route_end_lat, route_end_lon)
        if direct_res.get("success"):
            safe_data = {
                "geometry": direct_res["geometry"],
                "distance_m": direct_res["distance_m"],
                "duration_sec": direct_res["duration_sec"],
                "duration_mins": round(direct_res["duration_sec"] / 60.0, 1)
            }
        else:
            safe_data = norm_data
            
        detour_route_geojson = json.dumps({
            "success": True,
            "intersects_hazard": False,
            "normal_route": norm_data,
            "safe_route": safe_data,
            "closed_route": closed_route
        })

    # Now query the ML model
    police_officers = pred["logistics"]["police_officers"]
    barricades = pred["logistics"]["barricades"]
    cones = pred["logistics"]["traffic_cones"]
    vms_board = "Yes (Active Alert)" if pred["logistics"]["vms_board_active"] else "No (Passive monitoring)"
    
    # Build complete route info dict for suggestion agent
    route_info_dict = {
        "normal_route": norm_data,
        "safe_route": json.loads(detour_route_geojson)["safe_route"] if detour_route_geojson else norm_data,
        "closed_route": closed_route
    }
    
    sug_res = generate_suggestions_with_ai(
        cause=cause,
        priority=pred["priority"],
        lat=lat,
        lon=lon,
        description=description,
        requires_closure=requires_closure,
        pred_logistics=pred["logistics"],
        pred_metrics=pred,
        route_info=route_info_dict
    )
    immediate_action = sug_res["immediate_action"]
    tactical_instructions = sug_res["tactical_instructions"]
    markdown_content = sug_res["markdown_content"]
    
    # Custom commuter warning and action based on requires_closure
    cause_title = cause.replace('_', ' ').title()
    loc_name = address or 'reported location'
    if requires_closure:
        warning_msg = f"[ALERT] ROAD CLOSED: {cause_title} at {loc_name} requires full road closure."
        commuter_action = "Road is closed at the epicenter. Detour is active; follow green signs on the MiniMap to bypass."
    else:
        warning_msg = f"[ALERT] Traffic Slowdown: {cause_title} ahead at {loc_name}."
        commuter_action = "Road remains open. Proceed with caution; watch for slow-moving traffic."
        
    officer_suggestions_dict = {
        "immediate_action": immediate_action,
        "logistics": pred["logistics"],
        "junction_deployment": [f"Epicenter point ({police_officers} officers recommended)"],
        "tactical_instructions": tactical_instructions
    }
    traveler_suggestions_dict = {
        "warning_message": warning_msg,
        "eta_impact": f"Est. crossing time: {pred['etc_mins']} mins delay.",
        "detour_instructions": f"Detour advised. Impact radius: {pred['impact_radius_m']}m. {detour_desc}",
        "commuter_action": commuter_action
    }

    parsed_fields = {
        "event_cause": cause,
        "latitude": lat,
        "longitude": lon,
        "address": address,
        "requires_road_closure": requires_closure,
        "priority": pred["priority"],
        "veh_type": veh_type,
        "corridor": inferred_corridor,
        "initial_clearance_time_mins": int(pred["resolution_mins"]),
        "description": description if description else (sug_res.get("description") or ""),
        "endlatitude": payload_end_lat,
        "endlongitude": payload_end_lon
    }

    return {
        "confidence_score": 100.0,
        "support_text": "Officer-initiated event: AI recommendations compiled based on standard operational playbook.",
        "parsed_fields": parsed_fields,
        "officer_suggestions": json.dumps(officer_suggestions_dict),
        "traveler_suggestions": json.dumps(traveler_suggestions_dict),
        "detour_route_geojson": detour_route_geojson,
        "markdown_content": markdown_content,
        "delay_mins": int(pred["etc_mins"]),
        "requires_road_closure": requires_closure
    }

# ══════════════════════════════════════════════════════════════════════════════
# EVENTS (Active Incident Zones)
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/events")
def get_events(status: Optional[str] = "active", db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    query = db.query(Event)
    if status:
        query = query.filter(Event.status == status)
    events = query.order_by(Event.start_datetime.desc()).all()
    result = []
    for ev in events:
        update_dynamic_clearance(ev)
        result.append(serialize_event(ev))
    return result

@app.post("/api/events")
def create_event(payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(require_officer_or_admin)):
    lat = payload.get("latitude")
    lon = payload.get("longitude")
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="Latitude and Longitude are required")
    
    cause = payload.get("event_cause", "others")
    corridor = payload.get("corridor", "Non-corridor")
    requires_closure = payload.get("requires_road_closure", False)
    zone_type = "Red" if requires_closure else "Yellow"
    priority = payload.get("priority", "Low")
    veh_type = payload.get("veh_type", "unknown")
    clearance_time = payload.get("initial_clearance_time_mins", 60)
    description = payload.get("description", "")
    endlatitude = payload.get("endlatitude")
    endlongitude = payload.get("endlongitude")
    
    # Parse end coords if provided
    try:
        endlatitude = float(endlatitude) if endlatitude else None
    except (ValueError, TypeError):
        endlatitude = None
    try:
        endlongitude = float(endlongitude) if endlongitude else None
    except (ValueError, TypeError):
        endlongitude = None

    if requires_closure:
        if endlatitude is None or endlongitude is None:
            raise HTTPException(status_code=400, detail="End Latitude and End Longitude are mandatory when road closure is required")
    
    off_sug = payload.get("officer_suggestions")
    trav_sug = payload.get("traveler_suggestions")
    detour_geojson = payload.get("detour_route_geojson")
    
    if requires_closure and (not detour_geojson or detour_geojson == "null"):
        try:
            pred = get_complete_prediction(cause, corridor, 12, False, veh_type, requires_closure)
            h_rad = pred["impact_radius_m"]
            lat_delta = max((h_rad * 1.8) / 111000.0, 0.005)
            cos_lat = math.cos(math.radians(lat))
            lng_delta = max((h_rad * 1.8) / (111000.0 * cos_lat), 0.005) if cos_lat > 0 else lat_delta

            route_start_lat = lat - lat_delta
            route_start_lon = lon - lng_delta
            route_end_lat = lat + lat_delta
            route_end_lon = lon + lng_delta
            
            incidents_list = [{
                "latitude": lat,
                "longitude": lon,
                "endlatitude": endlatitude,
                "endlongitude": endlongitude,
                "impact_radius_m": h_rad,
                "requires_road_closure": True,
                "event_cause": cause
            }]
            
            routing_info = get_routing_with_detours(route_start_lat, route_start_lon, route_end_lat, route_end_lon, incidents_list)
            
            # Normal route through both start and end coordinates
            waypoints = []
            if lat is not None and lon is not None:
                waypoints.append((lat, lon))
            if endlatitude is not None and endlongitude is not None:
                waypoints.append((endlatitude, endlongitude))
            norm_res = get_route(route_start_lat, route_start_lon, route_end_lat, route_end_lon, waypoints=waypoints)
            if norm_res.get("success"):
                norm_data = {
                    "geometry": norm_res["geometry"],
                    "distance_m": norm_res["distance_m"],
                    "duration_sec": norm_res["duration_sec"],
                    "duration_mins": round(norm_res["duration_sec"] / 60.0, 1)
                }
            else:
                norm_data = routing_info.get("normal_route") or {
                    "geometry": {"type": "LineString", "coordinates": []},
                    "distance_m": 0,
                    "duration_sec": 0,
                    "duration_mins": 0
                }
            
            closed_route = get_closed_route_geojson(lat, lon, endlatitude, endlongitude)
            
            if routing_info.get("intersects_hazard") and routing_info.get("detour_route"):
                det_data = routing_info["detour_route"]
                detour_geojson = json.dumps({
                    "success": True,
                    "intersects_hazard": True,
                    "incident_cause": cause,
                    "normal_route": norm_data,
                    "safe_route": det_data,
                    "closed_route": closed_route
                })
            else:
                direct_res = get_route(route_start_lat, route_start_lon, route_end_lat, route_end_lon)
                if direct_res.get("success"):
                    safe_data = {
                        "geometry": direct_res["geometry"],
                        "distance_m": direct_res["distance_m"],
                        "duration_sec": direct_res["duration_sec"],
                        "duration_mins": round(direct_res["duration_sec"] / 60.0, 1)
                    }
                else:
                    safe_data = norm_data
                detour_geojson = json.dumps({
                    "success": True,
                    "intersects_hazard": False,
                    "normal_route": norm_data,
                    "safe_route": safe_data,
                    "closed_route": closed_route
                })
        except Exception as e:
            print(f"[WARN] Failed to pre-calculate detour route on creation: {e}")
    
    if not off_sug or not trav_sug:
        try:
            pred = get_complete_prediction(cause, corridor, 12, False, veh_type, requires_closure)
            off_dict = {
                "immediate_action": f"Secure perimeter. Deploy signs. Dispatch recovery units.",
                "logistics": pred.get("logistics", {}),
                "junction_deployment": [f"Epicenter point ({pred.get('logistics', {}).get('police_officers', 1)} officers recommended)"],
                "tactical_instructions": "Ensure safety lane remains open for emergency services."
            }
            trav_dict = {
                "warning_message": f"[ALERT] Congestion Warning: {cause.replace('_', ' ').title()} ahead.",
                "eta_impact": f"Est. crossing time: {pred.get('etc_mins', 10)} mins delay.",
                "detour_instructions": f"Detour advised. Impact radius: {pred.get('impact_radius_m', 300)}m.",
                "commuter_action": "Avoid this route if possible, or expect delays."
            }
            off_sug = json.dumps(off_dict)
            trav_sug = json.dumps(trav_dict)
        except Exception:
            off_sug = json.dumps({"immediate_action": "Secure the area.", "logistics": {}})
            trav_sug = json.dumps({"warning_message": "Traffic incident ahead. Expect delays."})
    
    event = Event(
        creator_id=current_user.id,
        latitude=lat,
        longitude=lon,
        address=payload.get("address", "Bengaluru, Karnataka"),
        event_cause=cause,
        requires_road_closure=requires_closure,
        zone_type=zone_type,
        priority=priority,
        veh_type=veh_type,
        initial_clearance_time_mins=clearance_time,
        current_clearance_time_mins=clearance_time,
        start_datetime=datetime.datetime.utcnow(),
        status="active",
        description=description,
        corridor=corridor,
        endlatitude=endlatitude,
        endlongitude=endlongitude,
        officer_suggestions=off_sug,
        traveler_suggestions=trav_sug,
        detour_route_geojson=detour_geojson
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    update_dynamic_clearance(event)
    return serialize_event(event)

@app.post("/api/events/{event_id}/snooze")
def snooze_event(event_id: str, payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(require_officer_or_admin)):
    mins = payload.get("snooze_mins", 30)
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    
    event.start_datetime = datetime.datetime.utcnow()
    event.initial_clearance_time_mins = mins
    event.current_clearance_time_mins = mins
    db.commit()
    db.refresh(event)
    update_dynamic_clearance(event)
    return serialize_event(event)

@app.post("/api/events/{event_id}/resolve")
def resolve_event(event_id: str, db: Session = Depends(get_db), current_user: User = Depends(require_officer_or_admin)):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    
    event.status = "resolved"
    event.current_clearance_time_mins = 0
    event.resolved_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(event)
    return serialize_event(event)

@app.post("/api/events/{event_id}/suggestions")
def get_event_suggestions(
    event_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if not check_service_permission("ai_suggestion", current_user.role, db):
        raise HTTPException(status_code=403, detail="AI Suggestions service is disabled for your role")
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
        
    cause = event.event_cause or "others"
    resolution_mins = event.initial_clearance_time_mins or 30
    requires_closure = event.requires_road_closure
    priority = event.priority or "Medium"
    
    # Query ML model first – use corridor stored with the event
    event_corridor = event.corridor or "Non-corridor"
    pred = get_complete_prediction(cause, event_corridor, 12, False, event.veh_type or "unknown", requires_closure)
    
    # 1. Fetch/Simulate detour routing if not stored or if it doesn't have a valid detour
    has_detour = False
    if event.detour_route_geojson:
        try:
            route_data = json.loads(event.detour_route_geojson)
            if route_data.get("success") and route_data.get("safe_route") and "closed_route" in route_data:
                has_detour = True
        except Exception:
            pass

    if not has_detour:
        h_rad = pred["impact_radius_m"]
        
        # Calculate detour start/end coordinates (rename local variables to avoid clashing)
        lat_delta = max((h_rad * 1.8) / 111000.0, 0.005)
        cos_lat = math.cos(math.radians(event.latitude))
        lng_delta = max((h_rad * 1.8) / (111000.0 * cos_lat), 0.005) if cos_lat > 0 else lat_delta

        route_start_lat = event.latitude - lat_delta
        route_start_lon = event.longitude - lng_delta
        route_end_lat = event.latitude + lat_delta
        route_end_lon = event.longitude + lng_delta
        
        incidents_list = [{
            "latitude": event.latitude,
            "longitude": event.longitude,
            "endlatitude": event.endlatitude,
            "endlongitude": event.endlongitude,
            "impact_radius_m": h_rad,
            "requires_road_closure": True,  # ALWAYS force True for suggestions detour preview
            "event_cause": cause
        }]
        
        routing_info = get_routing_with_detours(route_start_lat, route_start_lon, route_end_lat, route_end_lon, incidents_list)
        
        # Force the normal route to pass through both epicenter and end location as waypoints
        waypoints = [(event.latitude, event.longitude)]
        if requires_closure and event.endlatitude is not None and event.endlongitude is not None:
            waypoints = [(event.latitude, event.longitude), (event.endlatitude, event.endlongitude)]
        norm_res = get_route(route_start_lat, route_start_lon, route_end_lat, route_end_lon, waypoints=waypoints)
        if norm_res.get("success"):
            norm_data = {
                "geometry": norm_res["geometry"],
                "distance_m": norm_res["distance_m"],
                "duration_sec": norm_res["duration_sec"],
                "duration_mins": round(norm_res["duration_sec"] / 60.0, 1)
            }
        else:
            norm_data = routing_info.get("normal_route") or {
                "geometry": {"type": "LineString", "coordinates": []},
                "distance_m": 0,
                "duration_sec": 0,
                "duration_mins": 0
            }
            
        closed_route = None
        if requires_closure and event.endlatitude is not None and event.endlongitude is not None:
            closed_route = get_closed_route_geojson(event.latitude, event.longitude, event.endlatitude, event.endlongitude)

        if routing_info.get("intersects_hazard") and routing_info.get("detour_route"):
            det_data = routing_info["detour_route"]
            event.detour_route_geojson = json.dumps({
                "success": True,
                "intersects_hazard": True,
                "incident_cause": cause,
                "normal_route": norm_data,
                "safe_route": det_data,
                "closed_route": closed_route
            })
        else:
            direct_res = get_route(route_start_lat, route_start_lon, route_end_lat, route_end_lon)
            if direct_res.get("success"):
                safe_data = {
                    "geometry": direct_res["geometry"],
                    "distance_m": direct_res["distance_m"],
                    "duration_sec": direct_res["duration_sec"],
                    "duration_mins": round(direct_res["duration_sec"] / 60.0, 1)
                }
            else:
                safe_data = norm_data
                
            event.detour_route_geojson = json.dumps({
                "success": True,
                "intersects_hazard": False,
                "normal_route": norm_data,
                "safe_route": safe_data,
                "closed_route": closed_route
            })
        db.commit()
        db.refresh(event)

    # 2. Load or generate Suggestions
    off_sug = None
    if event.officer_suggestions:
        try:
            off_sug = json.loads(event.officer_suggestions)
            if "markdown_content" not in off_sug:
                off_sug = None
        except Exception:
            pass
            
    if not off_sug:
        # Generate dynamically
        police_officers = pred["logistics"]["police_officers"]
        barricades = pred["logistics"]["barricades"]
        cones = pred["logistics"]["traffic_cones"]
        
        parsed_route = json.loads(event.detour_route_geojson) if event.detour_route_geojson else None
        route_info_dict = {
            "normal_route": parsed_route.get("normal_route") if parsed_route else None,
            "safe_route": parsed_route.get("safe_route") if parsed_route else None,
            "closed_route": parsed_route.get("closed_route") if parsed_route else None
        }
        
        sug_res = generate_suggestions_with_ai(
            cause=cause,
            priority=priority,
            lat=event.latitude,
            lon=event.longitude,
            description=event.description or "",
            requires_closure=requires_closure,
            pred_logistics=pred["logistics"],
            pred_metrics=pred,
            route_info=route_info_dict
        )
        
        off_sug = {
            "immediate_action": sug_res["immediate_action"],
            "logistics": pred["logistics"],
            "junction_deployment": [f"Epicenter point ({police_officers} officers recommended)"],
            "tactical_instructions": sug_res["tactical_instructions"],
            "markdown_content": sug_res["markdown_content"]
        }
        event.officer_suggestions = json.dumps(off_sug)
        db.commit()
        db.refresh(event)
        
    # 3. Dynamic detour description and time comparison
    parsed_route = json.loads(event.detour_route_geojson) if event.detour_route_geojson else None
    detour_desc = "Refer to the interactive MiniMap for the alternate rerouting path to bypass this event spot."
    if parsed_route and parsed_route.get("intersects_hazard") and parsed_route.get("safe_route"):
        safe = parsed_route["safe_route"]
        norm = parsed_route.get("normal_route", safe)
        
        # Compare expected passing time without detour (normal route + estimated delay) vs detour route
        etc_mins = pred["etc_mins"]
        normal_with_delay = norm["duration_mins"] + etc_mins
        detour_mins = safe["duration_mins"]
        savings = normal_with_delay - detour_mins
        
        if savings > 0:
            comparison_text = f"Taking the detour saves approx {round(savings, 1)} mins compared to staying on the normal route in traffic."
        else:
            comparison_text = f"Taking the detour adds {round(-savings, 1)} mins to base travel time, but bypasses the blocked epicenter completely."
            
        detour_desc = (
            f"Detour is active. "
            f"Normal Route (with traffic delay): {round(normal_with_delay, 1)} mins "
            f"(includes {etc_mins} mins delay). "
            f"Detour Route: {round(detour_mins, 1)} mins. "
            f"{comparison_text}"
        )

    # 4. Generate user-role customized Markdown and dynamic traveler suggestions
    user_role = current_user.role
    
    # Custom dynamic warning message and commuter action based on requires_closure
    cause_title = cause.replace('_', ' ').title()
    loc_name = event.address or 'reported location'
    if requires_closure:
        warning_msg = f"[ALERT] ROAD CLOSED: {cause_title} at {loc_name} requires full road closure."
        commuter_action = "Road is closed at the epicenter. Detour is active; follow green signs on the MiniMap to bypass."
    else:
        warning_msg = f"[ALERT] Traffic Slowdown: {cause_title} ahead at {loc_name}."
        commuter_action = "Road remains open. Proceed with caution; watch for slow-moving traffic."
        
    trav_sug_dynamic = {
        "warning_message": warning_msg,
        "eta_impact": f"Est. crossing time: {pred['etc_mins']} mins delay.",
        "detour_instructions": f"Detour advised. Impact radius: {pred['impact_radius_m']}m. {detour_desc}",
        "commuter_action": commuter_action
    }
    
    # Update traveler suggestions dynamically in database if not set
    if not event.traveler_suggestions:
        event.traveler_suggestions = json.dumps(trav_sug_dynamic)
        db.commit()
        db.refresh(event)

    if user_role in ['Officer', 'Admin']:
        # Officer Output
        markdown_content = off_sug.get("markdown_content") or ""
    else:
        # Commuter Output
        header_title = "🛑 ROAD CLOSED ALERT" if requires_closure else "🚗 Commuter Delay Warning"
        markdown_content = f"""### {header_title}
- **Incident** – **{cause.replace('_', ' ').title()}** {'(Road Closed)' if requires_closure else '(Slow Traffic)'} ahead at **{event.address or 'Bengaluru'}**.
- **Estimated Crossing Delay** – Expect an estimated **{pred["etc_mins"]} minutes** delay when passing this corridor.
- **Impact Radius** – The traffic slowdown spans up to a **{pred["impact_radius_m"]}m** area.

### 🗺️ Rerouting & Alternate Directions
- **Commuter Action** – {trav_sug_dynamic['commuter_action']}
- **Detour Route Details** – {detour_desc}"""

    # Confidence score (static/deterministic calculation for active event)
    confidence_score = 90.0 if priority == 'High' else 75.0 if priority == 'Medium' else 50.0
    support_text = f"Active Incident Zone: Verified details from strategic planning databases."

    return {
        "confidence_score": confidence_score,
        "support_text": support_text,
        "markdown_content": markdown_content,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "endlatitude": event.endlatitude,
        "endlongitude": event.endlongitude,
        "routeData": parsed_route,
        "event_cause": event.event_cause,
        "address": event.address,
        "delay_mins": int(pred["etc_mins"]),
        "requires_road_closure": requires_closure
    }

# ══════════════════════════════════════════════════════════════════════════════
# DUAL ROUTING
# ══════════════════════════════════════════════════════════════════════════════



def is_float(val):
    try:
        float(val)
        return True
    except (ValueError, TypeError):
        return False

def geocode_query(query: str) -> dict:
    import urllib.parse
    q = query.strip()
    
    # Try parsing directly as lat,lng
    try:
        parts = [float(x.strip()) for x in q.split(',')]
        if len(parts) == 2:
            return {"lat": parts[0], "lon": parts[1]}
    except ValueError:
        pass

    # Use TomTom Search API if key is present
    if TOMTOM_API_KEY and TOMTOM_API_KEY != "YOUR_TOMTOM_API_KEY_HERE":
        try:
            url = f"https://api.tomtom.com/search/2/geocode/{urllib.parse.quote(q)}.json"
            resp = http_requests.get(url, params={
                "key": TOMTOM_API_KEY,
                "countrySet": "IN",
                "lat": 12.9716,
                "lon": 77.5946,
                "radius": 50000,
                "limit": 1
            }, timeout=3.0)
            if resp.status_code == 200:
                results = resp.json().get("results", [])
                if results:
                    pos = results[0].get("position", {})
                    if "lat" in pos and "lon" in pos:
                        return {"lat": pos["lat"], "lon": pos["lon"]}
        except Exception:
            pass

    # Fallback to OpenStreetMap Nominatim
    try:
        url = "https://nominatim.openstreetmap.org/search"
        resp = http_requests.get(url, params={
            "q": f"{q}, Bengaluru",
            "format": "json",
            "limit": 1
        }, headers={"User-Agent": "AstramApp/1.0"}, timeout=3.0)
        if resp.status_code == 200:
            results = resp.json()
            if results:
                return {"lat": float(results[0]["lat"]), "lon": float(results[0]["lon"])}
    except Exception:
        pass

    # Local hardcoded fallback spots for popular Bengaluru locations
    local_spots = {
        "yeshwanthpur": {"lat": 13.0238, "lon": 77.5529},
        "rajajinagar": {"lat": 12.9902, "lon": 77.5532},
        "mg road": {"lat": 12.9738, "lon": 77.6119},
        "malleshwaram": {"lat": 13.0031, "lon": 77.5643},
        "indiranagar": {"lat": 12.9719, "lon": 77.6412},
        "koramangala": {"lat": 12.9279, "lon": 77.6271},
        "jayanagar": {"lat": 12.9250, "lon": 77.5897},
        "electronic city": {"lat": 12.8452, "lon": 77.6760},
        "whitefield": {"lat": 12.9698, "lon": 77.7499},
        "outer ring road": {"lat": 12.9237, "lon": 77.6805},
        "hebbal": {"lat": 13.0359, "lon": 77.5970},
        "majestic": {"lat": 12.9779, "lon": 77.5724},
        "bengaluru": {"lat": 12.9716, "lon": 77.5946},
        "bangalore": {"lat": 12.9716, "lon": 77.5946}
    }
    
    q_lower = q.lower()
    for spot, coords in local_spots.items():
        if spot in q_lower:
            return coords

    return None

@app.post("/api/route")
def calculate_route(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if not check_service_permission("routing", current_user.role, db):
        raise HTTPException(status_code=403, detail="Route Planning service is disabled for your role")
        
    """Dual route: normal (traffic-only) and safe (incident-avoiding)."""
    start_lat = payload.get("start_lat")
    start_lon = payload.get("start_lon")
    end_lat = payload.get("end_lat")
    end_lon = payload.get("end_lon")
    
    if isinstance(start_lat, str) and not is_float(start_lat):
        coords = geocode_query(start_lat)
        if not coords:
            raise HTTPException(status_code=400, detail=f"Could not geocode start location: {start_lat}")
        start_lat = coords["lat"]
        start_lon = coords["lon"]
        
    if isinstance(end_lat, str) and not is_float(end_lat):
        coords = geocode_query(end_lat)
        if not coords:
            raise HTTPException(status_code=400, detail=f"Could not geocode end location: {end_lat}")
        end_lat = coords["lat"]
        end_lon = coords["lon"]
        
    try:
        start_lat = float(start_lat) if start_lat is not None else None
        start_lon = float(start_lon) if start_lon is not None else None
        end_lat = float(end_lat) if end_lat is not None else None
        end_lon = float(end_lon) if end_lon is not None else None
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Start and End coordinates must be valid numeric values")
        
    if None in [start_lat, start_lon, end_lat, end_lon]:
        raise HTTPException(status_code=400, detail="Start and End coordinates or geocodable locations are required")
    
    # Get normal route (no detours)
    normal_route = get_route(start_lat, start_lon, end_lat, end_lon)
    
    # Build incidents list for safe route
    active_red_events = db.query(Event).filter(
        Event.status == "active",
        Event.requires_road_closure == True
    ).all()
    
    incidents_list = []
    for ev in active_red_events:
        update_dynamic_clearance(ev)
        rad = calculate_impact_radius(ev.event_cause, ev.current_clearance_time_mins)
        incidents_list.append({
            "id": ev.id, "latitude": ev.latitude, "longitude": ev.longitude,
            "endlatitude": ev.endlatitude, "endlongitude": ev.endlongitude,
            "impact_radius_m": rad, "requires_road_closure": ev.requires_road_closure,
            "event_cause": ev.event_cause
        })
    
    # Get safe route (with detours around incidents)
    safe_result = get_routing_with_detours(start_lat, start_lon, end_lat, end_lon, incidents_list)
    
    result = {"success": True}
    
    if normal_route.get("success"):
        result["normal_route"] = {
            "geometry": normal_route["geometry"],
            "distance_m": normal_route["distance_m"],
            "duration_sec": normal_route["duration_sec"],
            "duration_mins": round(normal_route["duration_sec"] / 60.0, 1)
        }
    else:
        result["normal_route"] = None
    
    if safe_result.get("intersects_hazard") and safe_result.get("detour_route"):
        result["safe_route"] = safe_result["detour_route"]
        result["intersects_hazard"] = True
        result["incident_cause"] = safe_result.get("incident_cause")
    else:
        # Safe route is same as normal (no hazards)
        result["safe_route"] = result.get("normal_route")
        result["intersects_hazard"] = False
    
    return result

# ══════════════════════════════════════════════════════════════════════════════
# TRAFFIC HEATMAP (Viewport-based with TomTom + simulation fallback)
# ══════════════════════════════════════════════════════════════════════════════

def _generate_simulated_traffic(south, west, north, east, zoom, active_events):
    """Generate realistic time-based traffic simulation for Bangalore roads."""
    features = []
    
    # Major Bangalore road network segments
    bangalore_roads = [
        {"name": "MG Road", "coords": [[77.5946, 12.9750], [77.6050, 12.9738], [77.6150, 12.9720]]},
        {"name": "Brigade Road", "coords": [[77.6060, 12.9725], [77.6075, 12.9680], [77.6080, 12.9640]]},
        {"name": "Outer Ring Road N", "coords": [[77.5700, 13.0200], [77.5900, 13.0250], [77.6200, 13.0200], [77.6500, 13.0050]]},
        {"name": "Outer Ring Road S", "coords": [[77.6500, 13.0050], [77.6700, 12.9800], [77.6800, 12.9500], [77.6700, 12.9200]]},
        {"name": "Outer Ring Road W", "coords": [[77.5400, 12.9500], [77.5350, 12.9800], [77.5500, 13.0100], [77.5700, 13.0200]]},
        {"name": "Mysore Road", "coords": [[77.5700, 12.9600], [77.5400, 12.9450], [77.5100, 12.9350], [77.4900, 12.9300]]},
        {"name": "Hosur Road", "coords": [[77.6100, 12.9400], [77.6200, 12.9200], [77.6350, 12.9000], [77.6500, 12.8700]]},
        {"name": "Bellary Road", "coords": [[77.5900, 12.9900], [77.5880, 13.0100], [77.5920, 13.0400], [77.5950, 13.0600]]},
        {"name": "Old Madras Road", "coords": [[77.6100, 12.9800], [77.6400, 12.9900], [77.6700, 13.0000], [77.6900, 13.0100]]},
        {"name": "Tumkur Road", "coords": [[77.5500, 12.9900], [77.5300, 13.0100], [77.5100, 13.0300], [77.4900, 13.0500]]},
        {"name": "Bannerghatta Road", "coords": [[77.5950, 12.9400], [77.5930, 12.9100], [77.5900, 12.8800], [77.5880, 12.8500]]},
        {"name": "Sarjapur Road", "coords": [[77.6200, 12.9300], [77.6500, 12.9100], [77.6800, 12.9050], [77.7100, 12.9000]]},
        {"name": "Whitefield Main", "coords": [[77.7000, 12.9700], [77.7200, 12.9750], [77.7400, 12.9800], [77.7600, 12.9850]]},
        {"name": "Airport Road", "coords": [[77.5900, 12.9950], [77.5950, 13.0500], [77.6000, 13.1000], [77.6100, 13.1500]]},
        {"name": "Kanakapura Road", "coords": [[77.5750, 12.9350], [77.5600, 12.9000], [77.5500, 12.8600], [77.5400, 12.8200]]},
        {"name": "Magadi Road", "coords": [[77.5600, 12.9750], [77.5300, 12.9800], [77.5000, 12.9850]]},
        {"name": "Residency Road", "coords": [[77.5950, 12.9730], [77.5980, 12.9690], [77.6010, 12.9650]]},
        {"name": "Infantry Road", "coords": [[77.5930, 12.9800], [77.5920, 12.9850], [77.5910, 12.9900]]},
        {"name": "Lavelle Road", "coords": [[77.5960, 12.9680], [77.5970, 12.9640], [77.5980, 12.9600]]},
        {"name": "Koramangala Inner", "coords": [[77.6150, 12.9350], [77.6250, 12.9280], [77.6300, 12.9220]]},
        {"name": "Indiranagar 100ft", "coords": [[77.6350, 12.9780], [77.6400, 12.9760], [77.6450, 12.9740]]},
        {"name": "HSR Layout Main", "coords": [[77.6350, 12.9150], [77.6400, 12.9100], [77.6450, 12.9050]]},
        {"name": "JP Nagar Ring", "coords": [[77.5850, 12.9100], [77.5900, 12.9050], [77.5950, 12.9000]]},
        {"name": "Electronic City Flyover", "coords": [[77.6550, 12.8500], [77.6600, 12.8400], [77.6650, 12.8300]]},
        {"name": "Nice Road Segment", "coords": [[77.5200, 12.8800], [77.5400, 12.8600], [77.5600, 12.8500]]},
    ]
    
    # Time-based congestion (IST = UTC + 5:30)
    ist_hour = (datetime.datetime.utcnow().hour + 5) % 24 + 0.5
    
    # Rush hour patterns
    if 8 <= ist_hour <= 10.5:       base_congestion = 0.7   # Morning rush
    elif 17.5 <= ist_hour <= 20:    base_congestion = 0.75  # Evening rush
    elif 12 <= ist_hour <= 14:      base_congestion = 0.4   # Lunch moderate
    elif 22 <= ist_hour or ist_hour <= 5: base_congestion = 0.1  # Night low
    else:                            base_congestion = 0.3   # Normal
    
    for road in bangalore_roads:
        coords = road["coords"]
        
        # Check if road is within viewport bounds
        road_visible = False
        for lon, lat in coords:
            if south <= lat <= north and west <= lon <= east:
                road_visible = True
                break
        
        if not road_visible:
            continue
        
        # Base congestion with randomness
        congestion = base_congestion + random.uniform(-0.15, 0.15)
        
        # Major roads get more congestion during rush hours
        if "Ring Road" in road["name"] or "Airport" in road["name"]:
            congestion += 0.1
            
        # 20% chance of localized bottlenecks (lights, construction, trucks) even at night
        if random.random() < 0.20:
            congestion += random.uniform(0.3, 0.6)
        
        # Check proximity to active events
        for ev in active_events:
            for lon, lat in coords:
                dist_deg = math.sqrt((lat - ev.latitude)**2 + (lon - ev.longitude)**2)
                if dist_deg <= 0.01:  # ~1.1km
                    congestion += 0.3
                    break
                elif dist_deg <= 0.02:
                     congestion += 0.15
                     break
        
        congestion = max(0.0, min(1.0, congestion))
        
        # Map congestion to color
        if congestion >= 0.7:
            color = "#ef4444"  # Red
            speed = int(15 + (1 - congestion) * 20)
        elif congestion >= 0.4:
            color = "#f59e0b"  # Yellow/Orange
            speed = int(25 + (1 - congestion) * 30)
        else:
            color = "#22c55e"  # Green
            speed = int(40 + (1 - congestion) * 40)
        
        features.append({
            "type": "Feature",
            "properties": {
                "name": road["name"],
                "congestion": round(congestion, 2),
                "speed_kph": speed,
                "color": color
            },
            "geometry": {
                "type": "LineString",
                "coordinates": coords
            }
        })
        
    # Generate high-density grid of local streets inside viewport when zoomed in
    if zoom >= 14:
        grid_count = 6
        lat_step = (north - south) / (grid_count + 1)
        lon_step = (east - west) / (grid_count + 1)
        
        # Horizontal streets
        for i in range(1, grid_count + 1):
            lat = south + lat_step * i
            coords = []
            for j in range(5):
                curr_lon = west + (east - west) * (j / 4)
                curr_lat = lat + random.uniform(-0.0003, 0.0003)
                coords.append([curr_lon, curr_lat])
            
            for s in range(len(coords) - 1):
                seg_coords = [coords[s], coords[s+1]]
                # Distribute traffic: 50% Green, 30% Yellow, 20% Red
                rand = random.random()
                if rand >= 0.8:
                    congestion = random.uniform(0.7, 0.9)
                    color = "#ef4444"  # Red
                    speed = int(15 + (1 - congestion) * 20)
                elif rand >= 0.5:
                    congestion = random.uniform(0.4, 0.69)
                    color = "#f59e0b"  # Yellow
                    speed = int(25 + (1 - congestion) * 30)
                else:
                    congestion = random.uniform(0.05, 0.39)
                    color = "#22c55e"  # Green
                    speed = int(40 + (1 - congestion) * 40)
                    
                features.append({
                    "type": "Feature",
                    "properties": {
                        "name": f"Local Street H{i}-{s}",
                        "congestion": round(congestion, 2),
                        "speed_kph": speed,
                        "color": color
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": seg_coords
                    }
                })
                
        # Vertical streets
        for i in range(1, grid_count + 1):
            lon = west + lon_step * i
            coords = []
            for j in range(5):
                curr_lat = south + (north - south) * (j / 4)
                curr_lon = lon + random.uniform(-0.0003, 0.0003)
                coords.append([curr_lon, curr_lat])
                
            for s in range(len(coords) - 1):
                seg_coords = [coords[s], coords[s+1]]
                rand = random.random()
                if rand >= 0.8:
                    congestion = random.uniform(0.7, 0.9)
                    color = "#ef4444"
                    speed = int(15 + (1 - congestion) * 20)
                elif rand >= 0.5:
                    congestion = random.uniform(0.4, 0.69)
                    color = "#f59e0b"
                    speed = int(25 + (1 - congestion) * 30)
                else:
                    congestion = random.uniform(0.05, 0.39)
                    color = "#22c55e"
                    speed = int(40 + (1 - congestion) * 40)
                    
                features.append({
                    "type": "Feature",
                    "properties": {
                        "name": f"Local Street V{i}-{s}",
                        "congestion": round(congestion, 2),
                        "speed_kph": speed,
                        "color": color
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": seg_coords
                    }
                })
    
    return {"type": "FeatureCollection", "features": features}

def _fetch_tomtom_traffic(south, west, north, east, zoom, active_events):
    """Fetch real traffic data from TomTom Traffic Flow API."""
    features = []
    
    # Generate grid of sample points within viewport
    lat_step = (north - south) / 5
    lon_step = (east - west) / 5
    
    points = []
    for i in range(5):
        for j in range(5):
            lat = south + lat_step * (i + 0.5)
            lon = west + lon_step * (j + 0.5)
            points.append((lat, lon))
            
    def fetch_point(lat, lon):
        try:
            url = f"https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json"
            resp = http_requests.get(url, params={
                "point": f"{lat},{lon}",
                "key": TOMTOM_API_KEY,
                "unit": "KMPH"
            }, timeout=2.5)
            if resp.status_code == 200:
                return resp.json().get("flowSegmentData", {})
        except Exception:
            pass
        return None

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(lambda p: fetch_point(p[0], p[1]), points))
        
    for data in results:
        if not data:
            continue
        free_flow = data.get("freeFlowSpeed", 60)
        current_speed = data.get("currentSpeed", 60)
        coords_raw = data.get("coordinates", {}).get("coordinate", [])
        
        if coords_raw and free_flow > 0:
            coords = [[c["longitude"], c["latitude"]] for c in coords_raw]
            congestion = max(0, 1 - (current_speed / free_flow))
            
            if congestion >= 0.6:
                color = "#ef4444"
            elif congestion >= 0.3:
                color = "#f59e0b"
            else:
                color = "#22c55e"
            
            features.append({
                "type": "Feature",
                "properties": {
                    "congestion": round(congestion, 2),
                    "speed_kph": int(current_speed),
                    "free_flow_kph": int(free_flow),
                    "color": color
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords
                }
            })
            
    # Fallback to simulation if TomTom data is too sparse/rate-limited
    if len(features) < 5:
        return None
        
    return {"type": "FeatureCollection", "features": features}

@app.get("/api/traffic")
def get_live_traffic(
    bounds: str = Query(None, description="south,west,north,east"),
    zoom: int = Query(12),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if not check_service_permission("overlay", current_user.role, db) and not check_service_permission("density", current_user.role, db):
        raise HTTPException(status_code=403, detail="Traffic service is disabled for your role")
        
    """Returns traffic heatmap data for the visible viewport."""
    active_events = db.query(Event).filter(Event.status == "active").all()
    
    # Parse bounds
    if bounds:
        try:
            parts = [float(x) for x in bounds.split(",")]
            south, west, north, east = parts[0], parts[1], parts[2], parts[3]
        except (ValueError, IndexError):
            south, west, north, east = 12.85, 77.45, 13.10, 77.80
    else:
        south, west, north, east = 12.85, 77.45, 13.10, 77.80
    
    # Try TomTom first if key is set
    if TOMTOM_API_KEY and TOMTOM_API_KEY != "YOUR_TOMTOM_API_KEY_HERE":
        tomtom_data = _fetch_tomtom_traffic(south, west, north, east, zoom, active_events)
        if tomtom_data:
            return tomtom_data
    
    # Fallback to simulation
    return _generate_simulated_traffic(south, west, north, east, zoom, active_events)

# ══════════════════════════════════════════════════════════════════════════════
# ANALYTICS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/analytics")
def get_analytics(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    total_events = db.query(Event).count()
    active_events = db.query(Event).filter(Event.status == "active").count()
    resolved_events = db.query(Event).filter(Event.status == "resolved").count()
    
    cause_data = db.query(
        Event.event_cause, func.count(Event.id).label("count")
    ).group_by(Event.event_cause).order_by(text("count DESC")).limit(10).all()
    cause_list = [{"cause": row[0] or "unknown", "count": row[1]} for row in cause_data]
    
    addr_data = db.query(
        Event.address, func.count(Event.id).label("count")
    ).filter(Event.address != 'Bengaluru, Karnataka').group_by(Event.address).order_by(text("count DESC")).limit(10).all()
    location_list = [{"location": (row[0] or "Unknown").split(',')[0], "count": row[1]} for row in addr_data]
    
    res_data = db.query(
        Event.event_cause, func.avg(Event.initial_clearance_time_mins).label("avg_res")
    ).filter(Event.status == "resolved").group_by(Event.event_cause).order_by(text("avg_res DESC")).all()
    resolution_list = [{"cause": row[0] or "unknown", "avg_res_mins": round(row[1], 1)} for row in res_data]
    
    hour_field = func.strftime('%H', Event.start_datetime) if is_sqlite else func.extract('hour', Event.start_datetime)
    hour_data = db.query(
        hour_field.label("hour"), func.count(Event.id).label("count")
    ).group_by("hour").order_by("hour").all()
    hour_list = []
    for row in hour_data:
        if row[0] is not None:
            try:
                hour_list.append({"hour": int(row[0]), "count": row[1]})
            except Exception:
                pass
    
    return {
        "summary": {
            "total_events": total_events,
            "active_events": active_events,
            "resolved_events": resolved_events
        },
        "causes": cause_list,
        "locations": location_list,
        "resolutions": resolution_list,
        "hourly_distribution": hour_list
    }

# ══════════════════════════════════════════════════════════════════════════════
# AI AGENT ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/agent/parse")
def agent_parse_report(payload: dict = Body(...), current_user: User = Depends(get_current_user)):
    description = payload.get("description", "")
    latitude = payload.get("latitude")
    longitude = payload.get("longitude")
    
    if latitude is None or longitude is None:
        raise HTTPException(status_code=400, detail="Latitude and Longitude are required")
    
    try:
        return parse_report_with_ai(description, latitude, longitude)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI parsing failed: {str(e)}")

@app.post("/api/agent/chat")
def agent_chat_assistant(payload: dict = Body(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if not check_service_permission("chatbot", current_user.role, db):
        raise HTTPException(status_code=403, detail="AI Chatbot service is disabled for your role")
    
    message = payload.get("message", "")
    try:
        reply = run_chat_agent(message, current_user.role)
        return {"reply": reply}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI chat failed: {str(e)}")

# ══════════════════════════════════════════════════════════════════════════════
# HISTORICAL ANALYTICS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/analytics/historical")
def get_historical_analytics(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """
    Analyze historical event data from CSV file.
    Provides long-term trends, location hotspots, and operational insights.
    """
    import csv
    import os
    from collections import Counter, defaultdict
    from datetime import datetime as dt
    
    csv_path = os.path.join(os.path.dirname(__file__), "event_history.csv")
    
    if not os.path.exists(csv_path):
        raise HTTPException(status_code=404, detail="Historical data file not found")
    
    # Data containers
    events = []
    monthly_counts = defaultdict(int)
    cause_counts = Counter()
    location_counts = Counter()
    corridor_counts = Counter()
    zone_counts = Counter()
    vehicle_counts = Counter()
    priority_counts = Counter()
    status_counts = Counter()
    event_type_counts = Counter()
    hourly_counts = defaultdict(int)
    resolution_times = []
    closure_count = 0
    total_events = 0
    
    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                total_events += 1
                events.append(row)
                
                # Monthly trends
                if row.get('start_datetime'):
                    try:
                        start_dt = dt.fromisoformat(row['start_datetime'].replace('+00', ''))
                        month_key = start_dt.strftime('%Y-%m')
                        monthly_counts[month_key] += 1
                        
                        # Hourly distribution
                        hour = start_dt.hour
                        hourly_counts[hour] += 1
                    except Exception:
                        pass
                
                # Event causes
                cause = row.get('event_cause', 'unknown') or 'unknown'
                cause_counts[cause] += 1
                
                # Locations (clean up address)
                address = row.get('address', '')
                if address and address != 'Bengaluru, Karnataka':
                    # Extract main location name (first part before comma)
                    location = address.split(',')[0].strip()
                    if location:
                        location_counts[location] += 1
                
                # Corridors
                corridor = row.get('corridor', 'Non-corridor') or 'Non-corridor'
                corridor_counts[corridor] += 1
                
                # Zones
                zone = row.get('zone', 'Unknown') or 'Unknown'
                if zone and zone != 'Unknown':
                    zone_counts[zone] += 1
                
                # Vehicle types
                veh_type = row.get('veh_type', '')
                if veh_type:
                    vehicle_counts[veh_type] += 1
                
                # Priority
                priority = row.get('priority', 'Low') or 'Low'
                priority_counts[priority] += 1
                
                # Status
                status = row.get('status', 'unknown') or 'unknown'
                status_counts[status] += 1
                
                # Event type (planned/unplanned)
                event_type = row.get('event_type', 'unknown') or 'unknown'
                event_type_counts[event_type] += 1
                
                # Road closure
                requires_closure = row.get('requires_road_closure', 'FALSE')
                if requires_closure.upper() in ['TRUE', 'YES', '1']:
                    closure_count += 1
                
                # Resolution time calculation
                if row.get('start_datetime') and row.get('resolved_datetime'):
                    try:
                        start = dt.fromisoformat(row['start_datetime'].replace('+00', ''))
                        resolved = dt.fromisoformat(row['resolved_datetime'].replace('+00', ''))
                        diff_mins = int((resolved - start).total_seconds() / 60)
                        if diff_mins > 0 and diff_mins < 10000:  # Filter outliers
                            resolution_times.append(diff_mins)
                    except Exception:
                        pass
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse historical data: {str(e)}")
    
    # Calculate statistics
    avg_resolution = round(sum(resolution_times) / len(resolution_times), 1) if resolution_times else 0
    avg_events_per_month = round(total_events / len(monthly_counts), 1) if monthly_counts else 0
    closed_events = status_counts.get('closed', 0)
    closure_rate = round((closed_events / total_events * 100), 1) if total_events > 0 else 0
    
    # Format monthly trends (sorted)
    monthly_trend = [
        {"month": month, "count": count} 
        for month, count in sorted(monthly_counts.items())
    ]
    
    # Top event causes
    top_causes = [
        {"cause": cause, "count": count}
        for cause, count in cause_counts.most_common(10)
    ]
    
    # Top chronic problem locations
    top_locations = [
        {"location": loc, "count": count}
        for loc, count in location_counts.most_common(15)
    ]
    
    # Corridor analysis
    corridor_analysis = [
        {"corridor": corridor, "count": count}
        for corridor, count in corridor_counts.most_common()
    ]
    
    # Zone distribution
    zone_distribution = [
        {"zone": zone, "count": count}
        for zone, count in zone_counts.most_common()
    ]
    
    # Vehicle type breakdown
    vehicle_breakdown = [
        {"vehicle_type": veh, "count": count}
        for veh, count in vehicle_counts.most_common(10)
    ]
    
    # Priority distribution
    priority_distribution = [
        {"priority": priority, "count": count}
        for priority, count in sorted(priority_counts.items(), key=lambda x: ['High', 'Low'].index(x[0]) if x[0] in ['High', 'Low'] else 2)
    ]
    
    # Status distribution
    status_distribution = [
        {"status": status, "count": count}
        for status, count in status_counts.most_common()
    ]
    
    # Event type distribution
    event_type_distribution = [
        {"type": etype, "count": count}
        for etype, count in event_type_counts.most_common()
    ]
    
    # Hourly distribution
    hourly_distribution = [
        {"hour": hour, "count": hourly_counts.get(hour, 0)}
        for hour in range(24)
    ]
    
    # Most problematic corridor
    most_problematic_corridor = corridor_counts.most_common(1)[0][0] if corridor_counts else "N/A"
    most_common_cause = cause_counts.most_common(1)[0][0] if cause_counts else "N/A"
    
    return {
        "summary": {
            "total_events": total_events,
            "avg_events_per_month": avg_events_per_month,
            "most_problematic_corridor": most_problematic_corridor,
            "most_common_cause": most_common_cause.replace('_', ' ').title(),
            "avg_resolution_mins": avg_resolution,
            "closed_events": closed_events,
            "closure_rate_percent": closure_rate,
            "date_range": {
                "start": min(monthly_counts.keys()) if monthly_counts else "N/A",
                "end": max(monthly_counts.keys()) if monthly_counts else "N/A"
            }
        },
        "monthly_trend": monthly_trend,
        "causes": top_causes,
        "locations": top_locations,
        "corridors": corridor_analysis,
        "zones": zone_distribution,
        "vehicles": vehicle_breakdown,
        "priorities": priority_distribution,
        "statuses": status_distribution,
        "event_types": event_type_distribution,
        "hourly_distribution": hourly_distribution
    }
