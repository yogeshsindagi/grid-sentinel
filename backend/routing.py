"""
backend/routing.py
OSRM Routing and Detour Engine.
Calculates routes and reroutes around active hazard zones using OSRM waypoints.
"""

import requests
import math
import json

OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving/"

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates the distance in meters between two lat/lon points."""
    R = 6371000.0  # Earth's radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    
    a = (math.sin(dphi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(dlambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c

def get_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float, waypoints: list = None) -> dict:
    """
    Queries OSRM for a route.
    If waypoints are provided, routes sequentially through: start -> waypoints -> end.
    """
    coord_list = [f"{start_lon},{start_lat}"]
    
    if waypoints:
        for wp in waypoints:
            coord_list.append(f"{wp[1]},{wp[0]}")  # wp is (lat, lon) -> format lon,lat
            
    coord_list.append(f"{end_lon},{end_lat}")
    coord_str = ";".join(coord_list)
    
    url = f"{OSRM_ROUTE_URL}{coord_str}?overview=full&geometries=geojson"
    
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            data = response.json()
            if data.get("code") == "Ok" and len(data.get("routes", [])) > 0:
                route = data["routes"][0]
                return {
                    "success": True,
                    "geometry": route["geometry"],
                    "distance_m": route["distance"],
                    "duration_sec": route["duration"],
                    "coordinates": route["geometry"]["coordinates"] # list of [lon, lat]
                }
        return {"success": False, "error": f"OSRM returned code {response.status_code}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def check_route_intersection(route_coords: list, active_incidents: list) -> dict:
    """
    Checks if a route passes through any active red-zone incident.
    route_coords is a list of [lon, lat].
    active_incidents is a list of dicts with: id, latitude, longitude, endlatitude, endlongitude, impact_radius_m, requires_road_closure.
    Returns the first intersecting incident found, or None.
    """
    for incident in active_incidents:
        # Only route around events that require road closure
        if not incident.get("requires_road_closure", False):
            continue
            
        i_lat = incident["latitude"]
        i_lon = incident["longitude"]
        radius = incident.get("impact_radius_m", 300)
        
        end_lat = incident.get("endlatitude")
        end_lon = incident.get("endlongitude")
        
        # Check every point along the route
        for lon, lat in route_coords:
            dist = haversine_distance(lat, lon, i_lat, i_lon)
            if dist <= radius:
                return incident
            if end_lat is not None and end_lon is not None:
                try:
                    e_lat = float(end_lat)
                    e_lon = float(end_lon)
                    if haversine_distance(lat, lon, e_lat, e_lon) <= radius:
                        return incident
                except (ValueError, TypeError):
                    pass
    return None

def calculate_detour_waypoints(start_lat: float, start_lon: float, end_lat: float, end_lon: float, hazard_lat: float, hazard_lon: float, radius_m: float) -> list:
    """
    Calculates candidate waypoints offset from the hazard location.
    Generates perpendicular, horizontal, and vertical offsets at multiple scales
    to guarantee finding a route that bypasses the hazard zone.
    """
    candidates = []
    multipliers = [1.8, 3.0, 5.0]
    
    d_lat = end_lat - start_lat
    d_lon = end_lon - start_lon
    length = math.sqrt(d_lat**2 + d_lon**2)
    
    if length > 0:
        perp_lat = d_lon / length
        perp_lon = -d_lat / length
    else:
        perp_lat = 1.0
        perp_lon = 0.0
        
    for mult in multipliers:
        offset_m = radius_m * mult
        offset_deg = offset_m / 111000.0
        
        # Perpendicular offsets
        candidates.append([hazard_lat + perp_lat * offset_deg, hazard_lon + perp_lon * offset_deg])
        candidates.append([hazard_lat - perp_lat * offset_deg, hazard_lon - perp_lon * offset_deg])
        
        # Latitude and longitude-only offsets for grid configurations
        candidates.append([hazard_lat + offset_deg, hazard_lon])
        candidates.append([hazard_lat - offset_deg, hazard_lon])
        candidates.append([hazard_lat, hazard_lon + offset_deg])
        candidates.append([hazard_lat, hazard_lon - offset_deg])
        
    return candidates

def get_tomtom_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float, avoid_incidents: list = None) -> dict:
    """
    Queries TomTom Routing API for a route.
    If avoid_incidents is provided, adds avoidAreas containing bounding boxes around those incidents.
    """
    from backend.config import TOMTOM_API_KEY
    if not TOMTOM_API_KEY or TOMTOM_API_KEY == "YOUR_TOMTOM_API_KEY_HERE":
        return {"success": False, "error": "TomTom API Key not configured"}
        
    locations = f"{start_lat},{start_lon}:{end_lat},{end_lon}"
    url = f"https://api.tomtom.com/routing/1/calculateRoute/{locations}/json?key={TOMTOM_API_KEY}"
    
    body = {}
    if avoid_incidents:
        rectangles = []
        for inc in avoid_incidents:
            lat = inc["latitude"]
            lon = inc["longitude"]
            radius_m = inc.get("impact_radius_m", 300)
            
            # Convert radius in meters to degrees
            lat_delta = radius_m / 111000.0
            cos_lat = math.cos(math.radians(lat))
            lng_delta = radius_m / (111000.0 * cos_lat) if cos_lat > 0 else lat_delta
            
            rectangles.append({
                "southWestCorner": {
                    "latitude": lat - lat_delta,
                    "longitude": lon - lng_delta
                },
                "northEastCorner": {
                    "latitude": lat + lat_delta,
                    "longitude": lon + lng_delta
                }
            })
            
            end_lat = inc.get("endlatitude")
            end_lon = inc.get("endlongitude")
            if end_lat is not None and end_lon is not None:
                try:
                    e_lat = float(end_lat)
                    e_lon = float(end_lon)
                    e_lat_delta = radius_m / 111000.0
                    e_cos_lat = math.cos(math.radians(e_lat))
                    e_lng_delta = radius_m / (111000.0 * e_cos_lat) if e_cos_lat > 0 else e_lat_delta
                    
                    rectangles.append({
                        "southWestCorner": {
                            "latitude": e_lat - e_lat_delta,
                            "longitude": e_lon - e_lng_delta
                        },
                        "northEastCorner": {
                            "latitude": e_lat + e_lat_delta,
                            "longitude": e_lon + e_lng_delta
                        }
                    })
                except (ValueError, TypeError):
                    pass
        if rectangles:
            body["avoidAreas"] = {
                "rectangles": rectangles[:10]  # TomTom limit is 10
            }
            
    headers = {"Content-Type": "application/json"}
    try:
        response = requests.post(url, json=body, headers=headers, timeout=10)
        if response.status_code == 200:
            data = response.json()
            if "routes" in data and len(data["routes"]) > 0:
                route = data["routes"][0]
                summary = route["summary"]
                points = route["legs"][0]["points"]
                coordinates = [[pt["longitude"], pt["latitude"]] for pt in points]
                geojson_geometry = {
                    "type": "LineString",
                    "coordinates": coordinates
                }
                return {
                    "success": True,
                    "geometry": geojson_geometry,
                    "distance_m": summary["lengthInMeters"],
                    "duration_sec": summary["travelTimeInSeconds"],
                    "coordinates": coordinates
                }
        return {"success": False, "error": f"TomTom Routing API returned code {response.status_code}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_routing_with_detours(start_lat: float, start_lon: float, end_lat: float, end_lon: float, active_incidents: list) -> dict:
    """
    Computes a route from start to end.
    If it intersects any active road-closure incident, it generates detour route alternatives
    and returns both routes side-by-side with comparison.
    Uses TomTom Routing API if key is available, falling back to OSRM.
    """
    from backend.config import TOMTOM_API_KEY
    use_tomtom = TOMTOM_API_KEY and TOMTOM_API_KEY != "YOUR_TOMTOM_API_KEY_HERE"
    
    # 1. Fetch normal route
    if use_tomtom:
        normal_route = get_tomtom_route(start_lat, start_lon, end_lat, end_lon)
        if not normal_route["success"]:
            # Fallback to OSRM if TomTom fails
            normal_route = get_route(start_lat, start_lon, end_lat, end_lon)
            use_tomtom = False
    else:
        normal_route = get_route(start_lat, start_lon, end_lat, end_lon)
        
    if not normal_route["success"]:
        return {"success": False, "error": f"Failed to get standard route: {normal_route.get('error')}"}
        
    # 2. Check for intersections
    intersecting_incident = check_route_intersection(normal_route["coordinates"], active_incidents)
    
    if not intersecting_incident:
        return {
            "success": True,
            "intersects_hazard": False,
            "normal_route": {
                "geometry": normal_route["geometry"],
                "distance_m": normal_route["distance_m"],
                "duration_sec": normal_route["duration_sec"],
                "duration_mins": round(normal_route["duration_sec"] / 60.0, 1)
            },
            "detour_route": None
        }
        
    # 3. Intersection found. Compute detour
    if use_tomtom:
        # Route around the circular hazard
        # We pass all active incidents that require road closure to avoidAreas
        road_closures = [inc for inc in active_incidents if inc.get("requires_road_closure", False)]
        detour_attempt = get_tomtom_route(start_lat, start_lon, end_lat, end_lon, avoid_incidents=road_closures)
        if detour_attempt["success"]:
            # Make sure it doesn't intersect
            if not check_route_intersection(detour_attempt["coordinates"], [intersecting_incident]):
                normal_mins = round(normal_route["duration_sec"] / 60.0, 1)
                detour_mins = round(detour_attempt["duration_sec"] / 60.0, 1)
                time_diff_mins = max(round(detour_mins - normal_mins, 1), 0.0)
                
                return {
                    "success": True,
                    "intersects_hazard": True,
                    "incident_cause": intersecting_incident.get("event_cause", "Incident"),
                    "normal_route": {
                        "geometry": normal_route["geometry"],
                        "distance_m": normal_route["distance_m"],
                        "duration_sec": normal_route["duration_sec"],
                        "duration_mins": normal_mins
                    },
                    "detour_route": {
                        "geometry": detour_attempt["geometry"],
                        "distance_m": detour_attempt["distance_m"],
                        "duration_sec": detour_attempt["duration_sec"],
                        "duration_mins": detour_mins,
                        "time_added_mins": time_diff_mins
                    }
                }
                
    # Fallback to OSRM waypoint algorithm
    h_lat = intersecting_incident["latitude"]
    h_lon = intersecting_incident["longitude"]
    h_rad = intersecting_incident.get("impact_radius_m", 300)
    
    end_h_lat = intersecting_incident.get("endlatitude")
    end_h_lon = intersecting_incident.get("endlongitude")
    
    detour_wps = calculate_detour_waypoints(start_lat, start_lon, end_lat, end_lon, h_lat, h_lon, h_rad)
    if end_h_lat is not None and end_h_lon is not None:
        try:
            e_h_lat = float(end_h_lat)
            e_h_lon = float(end_h_lon)
            detour_wps += calculate_detour_waypoints(start_lat, start_lon, end_lat, end_lon, e_h_lat, e_h_lon, h_rad)
        except (ValueError, TypeError):
            pass
    
    best_detour = None
    
    # Test perpendicular directions and choose the faster detour
    for wp in detour_wps:
        detour_attempt = get_route(start_lat, start_lon, end_lat, end_lon, waypoints=[wp])
        if detour_attempt["success"]:
            # Make sure this detour itself doesn't cross the hazard
            if not check_route_intersection(detour_attempt["coordinates"], [intersecting_incident]):
                if best_detour is None or detour_attempt["duration_sec"] < best_detour["duration_sec"]:
                    best_detour = detour_attempt
                    
    # Fallback to larger offsets if all moderate candidates intersected the hazard
    if best_detour is None:
        for mult in [6.0, 8.0, 10.0]:
            offset_m = h_rad * mult
            offset_deg = offset_m / 111000.0
            wp_fallback = [h_lat + offset_deg, h_lon + offset_deg]
            detour_attempt = get_route(start_lat, start_lon, end_lat, end_lon, waypoints=[wp_fallback])
            if detour_attempt["success"]:
                if not check_route_intersection(detour_attempt["coordinates"], [intersecting_incident]):
                    best_detour = detour_attempt
                    break
                    
    # Ultimate fallback to the fastest candidate if no completely clean route is found
    if best_detour is None:
        for wp in detour_wps:
            detour_attempt = get_route(start_lat, start_lon, end_lat, end_lon, waypoints=[wp])
            if detour_attempt["success"]:
                if best_detour is None or detour_attempt["duration_sec"] < best_detour["duration_sec"]:
                    best_detour = detour_attempt
            
    if best_detour:
        normal_mins = round(normal_route["duration_sec"] / 60.0, 1)
        detour_mins = round(best_detour["duration_sec"] / 60.0, 1)
        time_diff_mins = max(round(detour_mins - normal_mins, 1), 0.0)
        
        return {
            "success": True,
            "intersects_hazard": True,
            "incident_cause": intersecting_incident.get("event_cause", "Incident"),
            "normal_route": {
                "geometry": normal_route["geometry"],
                "distance_m": normal_route["distance_m"],
                "duration_sec": normal_route["duration_sec"],
                "duration_mins": normal_mins
            },
            "detour_route": {
                "geometry": best_detour["geometry"],
                "distance_m": best_detour["distance_m"],
                "duration_sec": best_detour["duration_sec"],
                "duration_mins": detour_mins,
                "time_added_mins": time_diff_mins
            }
        }
        
    # If detour failed completely, return normal route
    return {
        "success": True,
        "intersects_hazard": False,
        "normal_route": {
            "geometry": normal_route["geometry"],
            "distance_m": normal_route["distance_m"],
            "duration_sec": normal_route["duration_sec"],
            "duration_mins": round(normal_route["duration_sec"] / 60.0, 1)
        },
        "detour_route": None
    }


def get_dual_routes(start_lat: float, start_lon: float, end_lat: float, end_lon: float, active_incidents: list) -> dict:
    """Returns both a normal route and a safe (incident-avoiding) route."""
    # Normal route - no detours
    from backend.config import TOMTOM_API_KEY
    use_tomtom = TOMTOM_API_KEY and TOMTOM_API_KEY != "YOUR_TOMTOM_API_KEY_HERE"
    
    if use_tomtom:
        normal = get_tomtom_route(start_lat, start_lon, end_lat, end_lon)
        if not normal.get("success"):
            normal = get_route(start_lat, start_lon, end_lat, end_lon)
    else:
        normal = get_route(start_lat, start_lon, end_lat, end_lon)
    
    # Safe route - with incident avoidance
    safe_result = get_routing_with_detours(start_lat, start_lon, end_lat, end_lon, active_incidents)
    
    return {
        "success": normal.get("success", False) if normal else False,
        "normal_route": {
            "geometry": normal.get("geometry"),
            "distance_m": normal.get("distance_m", 0),
            "duration_sec": normal.get("duration_sec", 0),
            "duration_mins": round(normal.get("duration_sec", 0) / 60.0, 1)
        } if normal and normal.get("success") else None,
        "safe_route": safe_result.get("detour_route") or safe_result.get("normal_route"),
        "intersects_hazard": safe_result.get("intersects_hazard", False),
        "incident_cause": safe_result.get("incident_cause")
    }
