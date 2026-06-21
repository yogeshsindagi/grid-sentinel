"""
backend/ai_agent.py
Azure AI Project Agent Integration.
Handles the "Star Button" report parsing and the "Ask AI" chatbot.
Includes appropriate tools and offline fallbacks.
"""

import os
import json
import re
from azure.ai.projects import AIProjectClient
from azure.core.credentials import TokenCredential, AccessToken

from .config import AZURE_ENDPOINT, AZURE_AGENT_ID, AZURE_API_KEY, AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_PROJECT_NAME
from .ml_model import get_complete_prediction, predict_clearance_time
from .routing import get_routing_with_detours
from .database import SessionLocal, Event
import datetime

class DummyCredential(TokenCredential):
    def get_token(self, *scopes, **kwargs) -> AccessToken:
        return AccessToken("dummy_token", 9999999999)

# Initialize Azure client safely
_project_client = None
_openai_client = None
_azure_active = False

def init_azure_client():
    global _project_client, _openai_client, _azure_active
    
    # Check if API Key is configured
    if not AZURE_API_KEY or AZURE_API_KEY == "YOUR_AZURE_API_KEY_HERE":
        print("[WARN] Azure API Key not set. Offline Mock Agent fallback active.")
        _azure_active = False
        return
        
    # Check if positional constructor arguments are missing
    missing = []
    if not AZURE_SUBSCRIPTION_ID:
        missing.append("AZURE_SUBSCRIPTION_ID")
    if not AZURE_RESOURCE_GROUP:
        missing.append("AZURE_RESOURCE_GROUP")
    if not AZURE_PROJECT_NAME:
        missing.append("AZURE_PROJECT_NAME")
        
    if missing:
        print(f"[WARN] Missing required Azure client arguments: {', '.join(missing)}")
        print("[INFO] Please configure AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, and AZURE_PROJECT_NAME (or AZURE_EXISTING_AIPROJECT_RESOURCE_ID) in backend/env.txt.")
        print("[WARN] Offline Mock Agent fallback active.")
        _azure_active = False
        return
        
    try:
        _project_client = AIProjectClient(
            endpoint=AZURE_ENDPOINT,
            subscription_id=AZURE_SUBSCRIPTION_ID,
            resource_group_name=AZURE_RESOURCE_GROUP,
            project_name=AZURE_PROJECT_NAME,
            credential=DummyCredential()
        )
        _openai_client = _project_client.get_openai_client(api_key=AZURE_API_KEY)
        _azure_active = True
        print(f"[OK] Azure AI Project client initialized for agent: {AZURE_AGENT_ID}")
    except Exception as e:
        print(f"[WARN] Failed to initialize Azure AI Project client: {e}. Offline Mock Agent active.")
        _azure_active = False

# Run initialization
init_azure_client()

# ── Local tools that the Agent can query ──────────────────────────────────────

def get_active_incidents_tool() -> str:
    """Gets a list of all active incidents from the database."""
    db = SessionLocal()
    try:
        events = db.query(Event).filter(Event.status == "active").all()
        result = []
        for e in events:
            result.append({
                "id": e.id,
                "cause": e.event_cause,
                "address": e.address,
                "priority": e.priority,
                "zone_type": e.zone_type,
                "current_clearance_mins": e.current_clearance_time_mins
            })
        return json.dumps(result)
    finally:
        db.close()

def get_historical_bottlenecks_tool(lat: float, lon: float, radius_m: float = 500.0) -> str:
    """Queries the SQLite database for historical incidents within a radius."""
    from .routing import haversine_distance
    db = SessionLocal()
    try:
        events = db.query(Event).all()
        matches = []
        for e in events:
            dist = haversine_distance(lat, lon, e.latitude, e.longitude)
            if dist <= radius_m:
                matches.append({
                    "cause": e.event_cause,
                    "address": e.address,
                    "initial_clearance_mins": e.initial_clearance_time_mins,
                    "status": e.status
                })
        return json.dumps(matches[:10])
    finally:
        db.close()

# ── The "Star Button" parsing engine ──────────────────────────────────────────

def parse_report_with_ai(description: str, lat: float, lon: float) -> dict:
    """
    Parses raw traveler reports, runs local ML/routing engines, and uses the 
    Azure Agent to compile it into a structured event creation schema.
    """
    # 1. Fetch historical bottlenecks nearby
    historical = get_historical_bottlenecks_tool(lat, lon, 500)
    
    # 2. Extract address and corridor approximation
    corridors = ["Mysore Road", "Bellary Road 1", "Tumkur Road", "Bellary Road 2", 
                 "Hosur Road", "ORR East 1", "ORR East 2", "Old Madras Road", "Magadi Road"]
    inferred_corridor = "Non-corridor"
    for c in corridors:
        if c.lower() in description.lower():
            inferred_corridor = c
            break
            
    # 3. Predict metrics locally using our pre-trained model
    # Heuristically parse cause
    inferred_cause = "others"
    causes_map = {
        "breakdown": "vehicle_breakdown", "accident": "accident", "water": "water_logging",
        "rain": "water_logging", "tree": "tree_fall", "metro": "construction",
        "construction": "construction", "pothole": "pot_holes", "hole": "pot_holes",
        "congestion": "congestion", "traffic": "congestion", "vip": "vip_movement",
        "rally": "public_event", "protest": "protest"
    }
    for keyword, cause_val in causes_map.items():
        if keyword in description.lower():
            inferred_cause = cause_val
            break
            
    hour = datetime.datetime.now().hour
    is_weekend = datetime.datetime.now().weekday() >= 5
    
    requires_closure = False
    if any(k in description.lower() for k in ["blocked", "closed", "underpass", "gridlock"]):
        requires_closure = True
        
    pred = get_complete_prediction(inferred_cause, inferred_corridor, hour, is_weekend, "unknown", requires_closure)
    
    # 4. Fetch detour route
    routing_info = get_routing_with_detours(lat, lon, lat + 0.05, lon + 0.05, [{
        "latitude": lat, "longitude": lon, "impact_radius_m": pred["impact_radius_m"],
        "requires_road_closure": requires_closure, "event_cause": inferred_cause
    }])
    
    detour_desc = "Refer to the interactive MiniMap for the alternate rerouting path to bypass this event spot."
    detour_geojson = None
    if routing_info.get("intersects_hazard"):
        det_data = routing_info["detour_route"]
        detour_desc = f"Detour route calculated. Adds {det_data['time_added_mins']} mins."
        detour_geojson = json.dumps(det_data["geometry"])

    # 5. Call Azure OpenAI client if active, otherwise trigger mock reasoning
    if _azure_active and _openai_client:
        prompt = f"""You are the GridLock Sentinel AI Agent. A Traffic Officer has requested automated forms generation for an incident.
Raw traveler text: "{description}"
Location: Lat {lat}, Lon {lon}
Inferred Corridor: {inferred_corridor}

Calculated metrics:
- Clearance time: {pred['resolution_mins']} minutes
- Priority: {pred['priority']}
- Logistics: Officers: {pred['logistics']['police_officers']}, Barricades: {pred['logistics']['barricades']}, Cones: {pred['logistics']['traffic_cones']}
- Detour delay: {detour_desc}
- Historical bottleneck events: {historical}

Format a response in EXACTLY this JSON structure. Do not output markdown codeblocks around it, just raw JSON:
{{
  "parsed_fields": {{
    "event_cause": "{pred['event_cause']}",
    "requires_road_closure": {str(requires_closure).lower()},
    "priority": "{pred['priority']}",
    "veh_type": "unknown",
    "initial_clearance_time_mins": {int(pred['resolution_mins'])},
    "address": "Inferred Address in Bengaluru near Lat {lat}"
  }},
  "officer_suggestions": {{
    "immediate_action": "Deploy response units to secure the perimeter. Set up warning signs.",
    "logistics_summary": "Deploy {pred['logistics']['police_officers']} officers and {pred['logistics']['barricades']} barricades.",
    "junction_deployment": ["Junction near Lat {lat} (traffic control)"],
    "tactical_instructions": "Establish safety perimeter. Divert heavy vehicles upstream."
  }},
  "traveler_suggestions": {{
    "warning_message": "[ALERT] Traffic Delay Warning: {pred['event_cause'].replace('_', ' ').title()} ahead.",
    "eta_impact": "Commuters will experience an estimated {pred['etc_mins']} minutes delay.",
    "detour_instructions": "Light vehicles detour around the closed zone. Alternate route is active."
  }}
}}"""
        try:
            my_agent = AZURE_AGENT_ID.split(":")[0] if ":" in AZURE_AGENT_ID else AZURE_AGENT_ID
            my_version = AZURE_AGENT_ID.split(":")[1] if ":" in AZURE_AGENT_ID else "1"
            
            response = _openai_client.responses.create(
                input=[{"role": "user", "content": prompt}],
                extra_body={"agent_reference": {"name": my_agent, "version": my_version, "type": "agent_reference"}}
            )
            
            clean_text = response.output_text.strip()
            # Strip out any potential ```json wrappers
            if clean_text.startswith("```"):
                lines = clean_text.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                clean_text = "\n".join(lines).strip()
                
            parsed_json = json.loads(clean_text)
            if "parsed_fields" in parsed_json:
                parsed_json["parsed_fields"]["initial_clearance_time_mins"] = int(pred["resolution_mins"])
            parsed_json["detour_route_geojson"] = detour_geojson
            return parsed_json
            
        except Exception as e:
            print(f"[WARN] Azure Agent parsing failed: {e}. Falling back to local template.")
            
    # Local fallback template if Azure is offline or failed
    officer_sug = {
        "immediate_action": f"Secure the incident perimeter immediately. Dispatch recovery vehicle for {pred['event_cause'].replace('_', ' ').title()}.",
        "logistics_summary": f"Deploy {pred['logistics']['police_officers']} officers, {pred['logistics']['barricades']} barricades, and {pred['logistics']['traffic_cones']} cones.",
        "junction_deployment": [
            f"Epicenter point ({pred['logistics']['police_officers']} officers recommended)"
        ],
        "tactical_instructions": f"Ensure safety lane is open. Divert heavy commercial vehicles upstream. Set up barricades."
    }
    
    traveler_sug = {
        "warning_message": f"[ALERT] High Congestion Warning: {pred['event_cause'].replace('_', ' ').title()} ahead. Expected delays.",
        "eta_impact": f"Commuters will experience an estimated {pred['etc_mins']} minutes delay.",
        "detour_instructions": f"Detour advised for light vehicles. {detour_desc}",
    }
    
    return {
        "parsed_fields": {
            "event_cause": pred["event_cause"],
            "requires_road_closure": requires_closure,
            "priority": pred["priority"],
            "veh_type": "unknown",
            "initial_clearance_time_mins": int(pred["resolution_mins"]),
            "address": f"Junction near Lat {lat}, Lon {lon}"
        },
        "officer_suggestions": officer_sug,
        "traveler_suggestions": traveler_sug,
        "detour_route_geojson": detour_geojson
    }

# ── Chatbot Widget Reasoning ──────────────────────────────────────────────────

def run_chat_agent(user_message: str, user_role: str = "Traveler") -> str:
    """
    Executes the conversational chatbot with Azure Agent client or local 
    reasoning fallback. Enforces strict role-based response rules.
    """
    # 1. Enforce Role restrictions
    role_rules = ""
    if user_role == "Traveler":
        role_rules = (
            "You are a helpful travel assistant for Bengaluru commuters. "
            "Rule: You must ONLY answer route directions, traffic delays, and travel warnings. "
            "Rule: Do NOT answer police officer deployments, barricade logistics, or admin settings. "
            "Keep instructions friendly and traveler-focused."
        )
    else:
        role_rules = (
            "You are a BTP Strategic Command Agent. "
            "You can answer police deployment strategies, logistical resources (barricades/manpower), "
            "historical bottleneck queries, and run ML simulator models."
        )
        
    # Query database records to provide live context
    active_incidents = get_active_incidents_tool()
    
    prompt = f"""System Rule: {role_rules}
Live database active traffic incidents context:
{active_incidents}

User role: {user_role}
User message: {user_message}

Formatting Instructions:
- Always format your output using standard markdown.
- Use headers (e.g. ### Section) if presenting multiple categories of information.
- Format lists with bullet points (e.g. - **Item Title** – detail text) and make sure each list item is on a new line.
- Separate paragraphs with double newlines (\n\n) so they are spaced neatly and readable.
- Convert raw URLs into clean markdown links: [label](url). Never output plain raw URLs.

Answer the user message. Keep it concise, specific to Bengaluru, and strictly adhering to your role rules."""

    if _azure_active and _openai_client:
        try:
            my_agent = AZURE_AGENT_ID.split(":")[0] if ":" in AZURE_AGENT_ID else AZURE_AGENT_ID
            my_version = AZURE_AGENT_ID.split(":")[1] if ":" in AZURE_AGENT_ID else "1"
            
            response = _openai_client.responses.create(
                input=[{"role": "user", "content": prompt}],
                extra_body={"agent_reference": {"name": my_agent, "version": my_version, "type": "agent_reference"}}
            )
            return response.output_text.strip()
        except Exception as e:
            print(f"[WARN] Azure Agent Chat failed: {e}. Using offline fallback.")
            
    # ── Offline Rule-based Chatbot Fallback ───────────────────────────────────
    msg_lower = user_message.lower()
    
    # Check if they are asking for active incidents
    if "incident" in msg_lower or "traffic" in msg_lower or "happen" in msg_lower:
        db = SessionLocal()
        try:
            events = db.query(Event).filter(Event.status == "active").all()
            if not events:
                return "Namaskara! There are currently no active traffic incidents reported in Bengaluru. Roads are clear."
            reply = f"Currently, there are **{len(events)}** active congestion zones in Bengaluru:\n\n"
            for e in events[:5]:
                reply += f"- **{e.event_cause.replace('_', ' ').title()}** near {e.address.split(',')[0]} ({e.zone_type} Zone).\n"
            return reply
        finally:
            db.close()
            
    # Check for officer logistics queries (Banned for travelers)
    if "officer" in msg_lower or "barricade" in msg_lower or "manpower" in msg_lower:
        if user_role == "Traveler":
            return "As a traveler assistant, I do not have access to police personnel deployment or barricade logistics. Please ask me about travel routes or traffic delays!"
        else:
            return "### BTP Logistics Recommendation\n\n- **Barricades & Officers**: Deploy dynamically based on the priority of the corridor.\n- **Corridors**: Mysore Road and Hosur Road require high priority coverage (5+ officers) during peak hours."
            
    if "route" in msg_lower or "go to" in msg_lower or "direction" in msg_lower:
        return "I can help you route! Please click the **Route Planner** circle icon on the right sidebar to open the planner panel. You can compute detours and view them dynamically on the map."
        
    return (
        f"Namaskara! I am your ASTrAM-GPT agent. \n\n"
        f"I can help you navigate Bengaluru traffic. "
        f"There are currently **{len(json.loads(active_incidents))}** active incidents reported on the map."
    )


def generate_suggestions_with_ai(
    cause: str,
    priority: str,
    lat: float,
    lon: float,
    description: str,
    requires_closure: bool,
    pred_logistics: dict,
    pred_metrics: dict = None,
    route_info: dict = None
) -> dict:
    """
    Generates contextual bullet points for immediate_action and tactical_instructions,
    along with a dynamic robust incident description if not already provided, and a detailed
    operational markdown report.
    Queries Azure OpenAI if active, otherwise falls back to dynamic local rules.
    """
    cause_str = cause.replace('_', ' ').title()
    pred_res_mins = pred_metrics.get("resolution_mins", 30.0) if pred_metrics else 30.0
    pred_etc_mins = pred_metrics.get("etc_mins", 15) if pred_metrics else 15
    pred_radius = pred_metrics.get("impact_radius_m", 300) if pred_metrics else 300
    pred_prop_risk = pred_metrics.get("propagation_risk", "Low") if pred_metrics else "Low"
    
    # Extract route distances/ETAs
    norm_dist_km = "N/A"
    norm_eta_mins = "N/A"
    detour_dist_km = "N/A"
    detour_eta_mins = "N/A"
    savings_text = "N/A"
    
    if route_info:
        norm_r = route_info.get("normal_route")
        if norm_r:
            norm_dist_km = f"{round(norm_r.get('distance_m', 0) / 1000.0, 2)} km"
            norm_eta_mins = f"{norm_r.get('duration_mins', 0)} mins"
            
        det_r = route_info.get("detour_route") or route_info.get("safe_route")
        if det_r:
            detour_dist_km = f"{round(det_r.get('distance_m', 0) / 1000.0, 2)} km"
            detour_eta_mins = f"{det_r.get('duration_mins', 0)} mins"
            
        if norm_r and det_r:
            norm_with_delay = norm_r.get('duration_mins', 0) + pred_etc_mins
            detour_mins = det_r.get('duration_mins', 0)
            savings = norm_with_delay - detour_mins
            if savings > 0:
                savings_text = f"Taking the detour saves approx {round(savings, 1)} mins compared to staying on the normal route in traffic."
            else:
                savings_text = f"Taking the detour adds {round(-savings, 1)} mins to base travel time, but bypasses the blocked epicenter completely."

    prompt = f"""You are the GridLock Sentinel AI Agent. A traffic officer is deploying response units for an incident in Bengaluru.
Incident Details:
- Cause/Type: {cause_str}
- Priority: {priority}
- Coordinates: Latitude {lat}, Longitude {lon}
- Road Closure Required: {requires_closure}
- Description: "{description}"
- Recommended Logistics: Police Officers: {pred_logistics.get('police_officers')}, Barricades: {pred_logistics.get('barricades')}, Cones: {pred_logistics.get('traffic_cones')}, VMS Active: {pred_logistics.get('vms_board_active')}
- Predictions:
  * Clearance Time: {pred_res_mins} minutes
  * Commuter Delay (ETC): {pred_etc_mins} minutes
  * Bottleneck Impact Radius: {pred_radius}m
  * Propagation Risk: {pred_prop_risk}
- Route Info:
  * Normal Route: Distance={norm_dist_km}, ETA={norm_eta_mins} (passes through epicenter)
  * Detour Route: Distance={detour_dist_km}, ETA={detour_eta_mins} (skips epicenter)
  * Rerouting Comparison: {savings_text}

Based on these details, please generate:
1. Dynamic Description: A realistic, concise (1-2 sentences) detailed description of this specific incident suitable for public alerts and official logs. It should reflect the incident type, priority, and road closure requirement. If a description is already provided, refine/paraphrase it or output it.
2. Immediate Response: A list of 2-3 short, clear action items to secure the perimeter.
3. Tactical Instructions: A list of 2-3 short, clear traffic management and detour instructions.
4. Markdown Content: A comprehensive, styled operational report detailing traffic bottlenecks, spillover impact, and specific guidelines for traffic police to manage flow and detour joins.
   Inside the markdown, you MUST generate:
   - A beautiful table of recommended logistics (officers, barricades, cones, VMS boards).
   - An analysis of the traffic propagation risk and bottleneck impact.
   - Guidelines for traffic officers to manage flow and detour joins.
   - Commuter guidance with route distances and ETAs.
   - CRITICAL FORMATTING RULE: You MUST use proper markdown formatting for bold headings and lists. Never output mismatched asterisks like `*Heading:**` or `**Heading:*`. Always format bold fields exactly as `**Heading:**` (with double asterisks on both sides) and if they are list items, ensure there is a space after the bullet: `- **Heading:** value`.

Format the output strictly as a JSON object:
{{
  "description": "Dynamic incident description",
  "immediate_action": ["Action point 1", "Action point 2"],
  "tactical_instructions": ["Instruction point 1", "Instruction point 2"],
  "markdown_content": "Full markdown operational report"
}}
Ensure the output is valid JSON and contain NO markdown code blocks around it."""

    if _azure_active and _openai_client:
        try:
            my_agent = AZURE_AGENT_ID.split(":")[0] if ":" in AZURE_AGENT_ID else AZURE_AGENT_ID
            my_version = AZURE_AGENT_ID.split(":")[1] if ":" in AZURE_AGENT_ID else "1"
            response = _openai_client.responses.create(
                input=[{"role": "user", "content": prompt}],
                extra_body={"agent_reference": {"name": my_agent, "version": my_version, "type": "agent_reference"}}
            )
            clean_text = response.output_text.strip()
            if clean_text.startswith("```"):
                lines = clean_text.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines[-1].startswith("```"):
                    lines = lines[:-1]
                clean_text = "\n".join(lines).strip()
            res = json.loads(clean_text)
            imm = res.get("immediate_action", [])
            tac = res.get("tactical_instructions", [])
            desc_val = res.get("description", "").strip()
            markdown_content = res.get("markdown_content", "").strip()
            if isinstance(imm, list) and isinstance(tac, list):
                imm_str = "\n  - " + "\n  - ".join([str(p).strip().lstrip("-* ").strip() for p in imm if str(p).strip()])
                tac_str = "\n  - " + "\n  - ".join([str(p).strip().lstrip("-* ").strip() for p in tac if str(p).strip()])
                if not markdown_content:
                    markdown_content = f"""### ⏱️ Operational Impact & Predictions
- **Predicted Clearance Time** – **{pred_res_mins} minutes** is required to fully resolve the incident.
- **Commuter Delay (ETC)** – Expect an estimated **{pred_etc_mins} minutes** delay when crossing the hazard zone.
- **Bottleneck Impact Radius** – The congestion impact is estimated to span a **{pred_radius}m** radius.
- **Propagation Risk** – Secondary bottleneck propagation risk is **{pred_prop_risk}** for adjacent corridors.

### 🛠️ Strategic Deployment Instructions
**Immediate Response**: {imm_str}

**Logistics Recommended**:
| Resource Type | Recommended Units | Allocation Priority |
| :--- | :--- | :--- |
| Police Officers | {pred_logistics.get('police_officers', 2)} | High (Epicenter Control) |
| Barricades | {pred_logistics.get('barricades', 2)} | Incident Perimeter Block |
| Traffic Cones | {pred_logistics.get('traffic_cones', 4)} | Channelization Lanes |
| VMS Alert Boards | {"Yes (Active Alert)" if pred_logistics.get('vms_board_active') else "No (Passive monitoring)"} | Upstream Diversion Pings |

**Tactical Directives**: {tac_str}

### 🚗 Commuter Guidance & Detours
- **Normal Route (with traffic)** – Distance: {norm_dist_km}, Base ETA: {norm_eta_mins} (delay: {pred_etc_mins} mins).
- **Detour Route (bypassing epicenter)** – Distance: {detour_dist_km}, ETA: {detour_eta_mins}.
- **Rerouting Recommendation** – {savings_text}"""
                
                return {
                    "immediate_action": imm_str,
                    "tactical_instructions": tac_str,
                    "description": desc_val,
                    "markdown_content": markdown_content
                }
        except Exception as e:
            print(f"[WARN] Failed to generate AI suggestions dynamically: {e}")

    # Offline dynamic fallback generator
    desc_templates = {
        'vehicle_breakdown': {
            'High': "A heavy commercial vehicle has broken down at the center of the corridor, causing complete blockage. Towing services are en route.",
            'Medium': "A passenger car has broken down on the main lane due to engine overheating. Traffic is slow-moving as vehicles lane-merge around it.",
            'Low': "A vehicle breakdown on the left shoulder is causing minor rubbernecking slowdowns. Assistance is on site."
        },
        'accident': {
            'High': "A major multi-vehicle collision has occurred, scattering debris across lanes. Emergency services and ambulances are on-site.",
            'Medium': "A fender-bender between two cars is blocking one lane. Vehicles are being moved to the shoulder to restore flow.",
            'Low': "A minor two-wheeler skid on the roadside. Traffic is moving normally with minor local slowdown."
        },
        'water_logging': {
            'High': "Severe waterlogging (flooding up to 2 feet) has submerged the underpass/corridor, rendering it impassable. Drainage teams deployed.",
            'Medium': "Moderate water accumulation on the low-lying lanes is causing speed drop to 10-15 km/h. High traffic congestion.",
            'Low': "Minor water pooling near the curb is causing vehicles to splash and slow down slightly. Drive with caution."
        },
        'tree_fall': {
            'High': "A massive tree has fallen across all lanes, bringing down electric poles. Emergency clearance teams are clearing it.",
            'Medium': "A large tree branch has fallen onto the left lane, partially obstructing the corridor. Local sweepers on it.",
            'Low': "Fallen tree foliage on the roadside. No lane blockage but causing minor caution slowdowns."
        },
        'construction': {
            'High': "Active metro building and heavy pillar construction work has restricted lane width. Expect high delays.",
            'Medium': "Ongoing utility/road repair works occupy the left lane. Speed limit restricted to 20 km/h with barricades in place.",
            'Low': "Road maintenance/repainting works on the shoulder. Traffic is moving smoothly with minor lane merges."
        },
        'road_conditions': {
            'High': "Severe road cave-in and structural asphalt damage has created a hazardous crater. Lane closed for emergency repairs.",
            'Medium': "Deep ruts and loose gravel on the corridor are forcing commuters to slow down drastically.",
            'Low': "Uneven surface and minor cracks on the road. Drive carefully."
        },
        'debris': {
            'High': "Spillage of gravel, sand, or construction material across all active lanes has blocked safe movement. Cleanup crew dispatched.",
            'Medium': "Fallen cargo/plastic debris on the central lane is causing vehicles to swerve and slow down.",
            'Low': "Minor debris on the side of the road. Clearance team alerted."
        },
        'congestion': {
            'High': "Severe bottleneck and traffic gridlock due to high volume traffic converging from adjacent intersections during peak hours.",
            'Medium': "Heavy traffic buildup on the corridor. Speeds have dropped to 10-15 km/h, tailbacks extending 800m.",
            'Low': "Standard peak-hour slow traffic. Queue is moving steadily."
        },
        'pot_holes': {
            'High': "A cluster of deep, water-filled potholes has caused multiple tyre punctures and sudden braking hazards.",
            'Medium': "Multiple medium-sized potholes are slowing down vehicular movement and causing bumper-to-bumper delays.",
            'Low': "Scattered potholes on the road stretch. Driving speed is slightly affected."
        },
        'public_event': {
            'High': "Large scale cultural festival or assembly with heavy pedestrian crowd. Roads closed surrounding the venue.",
            'Medium': "Local religious or sports gathering near the road. Minor traffic delays due to spectators.",
            'Low': "Small public gathering on the sidewalk. Traffic is unaffected."
        },
        'vip_movement': {
            'High': "State delegation convoy transit. Strict security blockade and full road closure enforced for clearance.",
            'Medium': "Temporary VIP convoy passage with rolling barricades. Expect short delays of 10-15 minutes.",
            'Low': "Convoy passing through with minor traffic control at major junctions."
        },
        'procession': {
            'High': "A massive religious/political procession marching along the main corridor, blocking all lanes. Diversions active.",
            'Medium': "A slow-moving procession occupying the left lane. Police escorting the marchers to manage traffic flow.",
            'Low': "Small rally moving along the shoulder. Minor slow down."
        },
        'protest': {
            'High': "Active sit-in demonstration and public rally blocking the entire junction. Police presence established to maintain order.",
            'Medium': "A peaceful protest on the side road causing slow traffic at the main corridor junction.",
            'Low': "Demonstration on the sidewalk/plaza. Traffic is moving normally."
        },
        'others': {
            'High': "A critical traffic hazard and safety emergency requires immediate road block and operational deployment.",
            'Medium': "An isolated traffic disturbance is causing moderate slowdowns. Monitoring closely.",
            'Low': "Minor roadside issue reported. Traffic flow is normal."
        }
    }

    prio_key = priority if priority in ['High', 'Medium', 'Low'] else 'Medium'
    cause_key = cause if cause in desc_templates else 'others'
    desc_val = description if description else desc_templates[cause_key][prio_key]
    
    if requires_closure and "closure" not in desc_val.lower():
        desc_val += " Full road closure is active at the epicenter."

    immediate_points = [
        f"Dispatch response units to coordinates {lat:.4f}, {lon:.4f} immediately.",
        f"Deploy {pred_logistics.get('police_officers', 2)} traffic officers to establish epicenter control.",
        f"Position {pred_logistics.get('barricades', 2)} barricades to secure the incident perimeter."
    ]
    tactical_points = [
        "Direct heavy commercial vehicles to detour upstream junctions.",
        f"Deploy {pred_logistics.get('traffic_cones', 4)} cones to channelize remaining lanes.",
        "Update digital alert boards upstream to inform commuters."
    ]
    if requires_closure:
        immediate_points.append("Implement full road block and display clear closure alerts.")
        tactical_points.append("Divert all approaching traffic to alternate routes.")
    else:
        tactical_points.append("Keep at least one corridor lane open for transit flow.")

    imm_str = "\n  - " + "\n  - ".join(immediate_points)
    tac_str = "\n  - " + "\n  - ".join(tactical_points)

    vms_active = pred_logistics.get("vms_board_active", False)
    vms_board = "Yes (Active Alert)" if vms_active else "No (Passive monitoring)"
    
    imm_render = f"**Immediate Response**:{imm_str}"
    tac_render = f"**Tactical Directives**:{tac_str}"
    
    markdown_content = f"""### ⏱️ Operational Impact & Predictions
- **Predicted Clearance Time** – **{pred_res_mins} minutes** is required to fully resolve the incident.
- **Commuter Delay (ETC)** – Expect an estimated **{pred_etc_mins} minutes** delay when crossing the hazard zone.
- **Bottleneck Impact Radius** – The congestion impact is estimated to span a **{pred_radius}m** radius.
- **Propagation Risk** – Secondary bottleneck propagation risk is **{pred_prop_risk}** for adjacent corridors.

### 🛠️ Strategic Deployment Instructions
{imm_render}

**Logistics Recommended**:
| Resource Type | Recommended Units | Allocation Priority |
| :--- | :--- | :--- |
| Police Officers | {pred_logistics.get('police_officers', 2)} | High (Epicenter Control) |
| Barricades | {pred_logistics.get('barricades', 2)} | Incident Perimeter Block |
| Traffic Cones | {pred_logistics.get('traffic_cones', 4)} | Channelization Lanes |
| VMS Alert Boards | {vms_board} | Upstream Diversion Pings |

{tac_render}

### 🚗 Commuter Guidance & Detours
- **Normal Route (with traffic)** – Distance: {norm_dist_km}, Base ETA: {norm_eta_mins} (delay: {pred_etc_mins} mins).
- **Detour Route (bypassing epicenter)** – Distance: {detour_dist_km}, ETA: {detour_eta_mins}.
- **Rerouting Recommendation** – {savings_text}
- **Traffic Officer Guidelines** – Secure detour entry/exit joins, guide traffic merge points, and monitor propagation on adjacent lanes."""

    return {
        "immediate_action": imm_str,
        "tactical_instructions": tac_str,
        "description": desc_val,
        "markdown_content": markdown_content
    }

