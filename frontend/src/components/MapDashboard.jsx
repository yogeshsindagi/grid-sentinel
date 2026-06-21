import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '../utils/api';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const BANGALORE_CENTER = [77.5946, 12.9716];

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const MapDashboard = forwardRef(function MapDashboard({ events = [], routeData, draftClosedRoute, onMapRightClick, onEventClick, userLocation, trafficOverlayAllowed, mapClickCoords, onMapClick }, ref) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const trafficTimerRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const contextMarkerRef = useRef(null);
  const gpsMarkerRef = useRef(null);
  const activeClosureMarkersRef = useRef([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(null);

  useImperativeHandle(ref, () => ({
    flyTo: (loc) => {
      if (mapRef.current) mapRef.current.flyTo({ center: [loc.lng, loc.lat], zoom: 15, duration: 1500 });
    },
    getMap: () => mapRef.current,
    clearTraffic: () => {
      if (mapRef.current) {
        const src = mapRef.current.getSource('traffic');
        if (src) src.setData(EMPTY_FC);
      }
    },
    triggerTrafficFetch: async (customBounds, customZoom) => {
      if (mapRef.current) {
        await fetchTraffic(mapRef.current, customBounds, customZoom);
      }
    }
  }));

  const onMapRightClickRef = useRef(onMapRightClick);
  const onEventClickRef = useRef(onEventClick);
  const onMapClickRef = useRef(onMapClick);

  useEffect(() => {
    onMapRightClickRef.current = onMapRightClick;
    onEventClickRef.current = onEventClick;
    onMapClickRef.current = onMapClick;
  });

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: MAP_STYLE,
        center: BANGALORE_CENTER,
        zoom: 12,
        attributionControl: false,
        maxBounds: [[76.5, 12.2], [78.5, 13.8]]
      });
    } catch (err) {
      console.error("Failed to construct MapLibre Map:", err);
      setMapError("Failed to initialize map engine. Please check your browser's WebGL settings.");
      return;
    }

    map.on('error', (e) => {
      console.warn("MapLibre GL warning/error:", e.message || e);
      // We only alert the user if the stylesheet fails to load
      if (e.message?.includes('style') || e.message?.includes('403') || e.message?.includes('404')) {
        setMapError(`Map Style Error: Unable to load CartoDB tile service (${e.message || 'unknown error'})`);
      }
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('load', () => {
      // Traffic heatmap layer
      map.addSource('traffic', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'traffic-lines',
        type: 'line',
        source: 'traffic',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 5, 18, 10],
          'line-opacity': [
            'case',
            ['==', ['get', 'color'], '#ef4444'], 1.0,
            ['==', ['get', 'color'], '#f59e0b'], 0.6,
            ['==', ['get', 'color'], '#22c55e'], 0.25,
            0.7
          ]
        }
      });

      // Event hazard zones
      map.addSource('hazard-zones', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'hazard-zones-fill',
        type: 'circle',
        source: 'hazard-zones',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 14, 30, 18, 60],
          'circle-color': ['case', ['==', ['get', 'zone_type'], 'Red'], 'rgba(239, 68, 68, 0.12)', 'rgba(245, 158, 11, 0.15)'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': ['case', ['==', ['get', 'zone_type'], 'Red'], 'rgba(239, 68, 68, 0.4)', 'rgba(245, 158, 11, 0.40)'],
          'circle-opacity': ['case', ['any', ['==', ['get', 'requires_road_closure'], true], ['==', ['get', 'requires_road_closure'], 'true']], 0, 1],
          'circle-stroke-opacity': ['case', ['any', ['==', ['get', 'requires_road_closure'], true], ['==', ['get', 'requires_road_closure'], 'true']], 0, 1]
        }
      });

      // Event markers
      map.addSource('event-markers', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'event-markers-circle',
        type: 'circle',
        source: 'event-markers',
        paint: {
          'circle-radius': 8,
          'circle-color': ['case', ['==', ['get', 'zone_type'], 'Red'], '#ef4444', '#f59e0b'],
          'circle-stroke-width': 3,
          'circle-stroke-color': ['case', ['==', ['get', 'zone_type'], 'Red'], 'rgba(239,68,68,0.3)', 'rgba(245,158,11,0.3)'],
          'circle-opacity': ['case', ['any', ['==', ['get', 'requires_road_closure'], true], ['==', ['get', 'requires_road_closure'], 'true']], 0, 1],
          'circle-stroke-opacity': ['case', ['any', ['==', ['get', 'requires_road_closure'], true], ['==', ['get', 'requires_road_closure'], 'true']], 0, 1]
        }
      });
      map.addLayer({
        id: 'event-markers-inner',
        type: 'circle',
        source: 'event-markers',
        paint: {
          'circle-radius': 4,
          'circle-color': 'white',
          'circle-opacity': ['case', ['any', ['==', ['get', 'requires_road_closure'], true], ['==', ['get', 'requires_road_closure'], 'true']], 0, 1]
        }
      });

      // Route layers
      map.addSource('normal-route', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'normal-route-line',
        type: 'line',
        source: 'normal-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#3b82f6', 'line-width': 5, 'line-opacity': 0.85 }
      });

      map.addSource('safe-route', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'safe-route-line',
        type: 'line',
        source: 'safe-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#22c55e', 'line-width': 5, 'line-opacity': 0.85, 'line-dasharray': [2, 2] }
      });

      // Closed road segments for active events
      map.addSource('closed-road-segments', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'closed-road-segments-line',
        type: 'line',
        source: 'closed-road-segments',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ef4444', 'line-width': 6, 'line-opacity': 0.8 }
      });

      // Draft closed road segment (during event creation)
      map.addSource('draft-closed-route', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'draft-closed-route-line',
        type: 'line',
        source: 'draft-closed-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ef4444', 'line-width': 6, 'line-opacity': 0.8 }
      });

      // GPS location source
      map.addSource('gps-location', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'gps-accuracy',
        type: 'circle',
        source: 'gps-location',
        paint: { 'circle-radius': 30, 'circle-color': 'rgba(59, 130, 246, 0.1)', 'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(59, 130, 246, 0.3)' }
      });
      map.addLayer({
        id: 'gps-dot',
        type: 'circle',
        source: 'gps-location',
        paint: { 'circle-radius': 7, 'circle-color': '#3b82f6', 'circle-stroke-width': 3, 'circle-stroke-color': 'white' }
      });

      // Route markers (start and end points)
      map.addSource('route-markers', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: 'route-markers-circle',
        type: 'circle',
        source: 'route-markers',
        paint: {
          'circle-radius': 12,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff'
        }
      });
      map.addLayer({
        id: 'route-markers-label',
        type: 'symbol',
        source: 'route-markers',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': 11,
          'text-offset': [0, 2.2],
          'text-anchor': 'top'
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 2
        }
      });
      setMapLoaded(true);
    });

    // Right click for report
    map.on('contextmenu', (e) => {
      e.preventDefault();
      const { lat, lng } = e.lngLat;
      if (onMapRightClickRef.current) onMapRightClickRef.current({ lat, lng });
    });

    // Touch long-press
    map.getCanvas().addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        longPressTimerRef.current = setTimeout(() => {
          const rect = map.getCanvas().getBoundingClientRect();
          const point = new maplibregl.Point(
            e.touches[0].clientX - rect.left,
            e.touches[0].clientY - rect.top
          );
          const lngLat = map.unproject(point);
          if (onMapRightClickRef.current) onMapRightClickRef.current({ lat: lngLat.lat, lng: lngLat.lng });
        }, 600);
      }
    });
    map.getCanvas().addEventListener('touchend', () => clearTimeout(longPressTimerRef.current));
    map.getCanvas().addEventListener('touchmove', () => clearTimeout(longPressTimerRef.current));

    // Click on event markers
    map.on('click', 'event-markers-circle', (e) => {
      if (e.features?.length > 0) {
        const f = e.features[0];
        const props = f.properties;
        if (onEventClickRef.current) onEventClickRef.current(props);
      }
    });
    map.on('mouseenter', 'event-markers-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'event-markers-circle', () => { map.getCanvas().style.cursor = ''; });

    // Click on active closed road segments
    map.on('click', 'closed-road-segments-line', (e) => {
      if (e.features?.length > 0) {
        const f = e.features[0];
        const props = f.properties;
        if (onEventClickRef.current) onEventClickRef.current(props);
      }
    });
    map.on('mouseenter', 'closed-road-segments-line', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'closed-road-segments-line', () => { map.getCanvas().style.cursor = ''; });

    map.on('click', (e) => {
      if (!map.loaded()) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['event-markers-circle'] });
      if (features.length === 0) {
        if (onMapClickRef.current) onMapClickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      if (contextMarkerRef.current) {
        contextMarkerRef.current.remove();
        contextMarkerRef.current = null;
      }
      activeClosureMarkersRef.current.forEach(m => m.remove());
      activeClosureMarkersRef.current = [];
    };
  }, []);

  // Manage context marker reactively
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    if (contextMarkerRef.current) {
      contextMarkerRef.current.remove();
      contextMarkerRef.current = null;
    }

    if (mapClickCoords) {
      const el = document.createElement('div');
      el.style.cssText = 'width:20px;height:20px;background:#ef4444;border:3px solid white;border-radius:50%;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.5);';
      contextMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([mapClickCoords.lng, mapClickCoords.lat])
        .addTo(map);
    }
  }, [mapClickCoords, mapLoaded]);

  // Clear traffic if overlay is disabled
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    if (!trafficOverlayAllowed) {
      const src = mapRef.current.getSource('traffic');
      if (src) src.setData(EMPTY_FC);
    }
  }, [trafficOverlayAllowed, mapLoaded]);

  // Fetch traffic data
  const fetchTraffic = useCallback(async (map, customBounds, customZoom) => {
    if (!map) return;
    if (!trafficOverlayAllowed) return;
    const zoom = customZoom || map.getZoom();
    if (zoom < 11) return;
    
    let boundsArr;
    if (customBounds) {
      boundsArr = customBounds;
    } else {
      const bounds = map.getBounds();
      boundsArr = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
    }
    
    try {
      const data = await api.getTraffic(boundsArr, Math.round(zoom));
      const src = map.getSource('traffic');
      if (src) src.setData(data);
    } catch (e) {}
  }, [trafficOverlayAllowed]);

  // Update event markers and active closure S/E markers
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    const markerFeatures = events.map(ev => {
      const zoneTypeNormalized = ev.zone_type === 'Red' || ev.zone_type === 'red' ? 'Red' : 'Yellow';
      const closureBool = ev.requires_road_closure === true || ev.requires_road_closure === 1 || ev.requires_road_closure === 'true';
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [parseFloat(ev.longitude), parseFloat(ev.latitude)] },
        properties: {
          id: ev.id, 
          event_cause: ev.event_cause, 
          zone_type: zoneTypeNormalized,
          priority: ev.priority, 
          address: ev.address,
          clearance_mins: ev.current_clearance_time_mins,
          requires_road_closure: closureBool
        }
      };
    });

    const src1 = map.getSource('event-markers');
    if (src1) src1.setData({ type: 'FeatureCollection', features: markerFeatures });

    const hazardFeatures = events.map(ev => {
      const zoneTypeNormalized = ev.zone_type === 'Red' || ev.zone_type === 'red' ? 'Red' : 'Yellow';
      const closureBool = ev.requires_road_closure === true || ev.requires_road_closure === 1 || ev.requires_road_closure === 'true';
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [parseFloat(ev.longitude), parseFloat(ev.latitude)] },
        properties: { 
          zone_type: zoneTypeNormalized, 
          requires_road_closure: closureBool 
        }
      };
    });
    const src2 = map.getSource('hazard-zones');
    if (src2) src2.setData({ type: 'FeatureCollection', features: hazardFeatures });

    const closedFeatures = [];
    events.forEach(ev => {
      if (ev.requires_road_closure && ev.detour_route_geojson) {
        try {
          const routeObj = typeof ev.detour_route_geojson === 'string'
            ? JSON.parse(ev.detour_route_geojson)
            : ev.detour_route_geojson;
          if (routeObj?.closed_route?.geometry) {
            closedFeatures.push({
              type: 'Feature',
              geometry: routeObj.closed_route.geometry,
              properties: {
                id: ev.id,
                event_cause: ev.event_cause,
                zone_type: ev.zone_type,
                priority: ev.priority,
                address: ev.address,
                clearance_mins: ev.current_clearance_time_mins,
                requires_road_closure: ev.requires_road_closure
              }
            });
          }
        } catch (e) {
          console.warn("Failed to parse detour_route_geojson for event", ev.id, e);
        }
      }
    });
    const srcClosed = map.getSource('closed-road-segments');
    if (srcClosed) srcClosed.setData({ type: 'FeatureCollection', features: closedFeatures });

    // Clean up old active closure markers
    activeClosureMarkersRef.current.forEach(m => m.remove());
    activeClosureMarkersRef.current = [];

    // Place custom S/E HTML markers for active road closures
    events.forEach(ev => {
      if (ev.requires_road_closure) {
        // Start marker 'S'
        const elS = document.createElement('div');
        elS.style.cssText = 'width:20px;height:20px;background:#ef4444;border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:10px;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;z-index:5;';
        elS.innerText = 'S';
        elS.onclick = (e) => {
          e.stopPropagation();
          if (onEventClickRef.current) {
            onEventClickRef.current({
              id: ev.id,
              event_cause: ev.event_cause,
              zone_type: ev.zone_type,
              priority: ev.priority,
              address: ev.address,
              clearance_mins: ev.current_clearance_time_mins
            });
          }
        };
        const markerS = new maplibregl.Marker({ element: elS })
          .setLngLat([ev.longitude, ev.latitude])
          .addTo(map);
        activeClosureMarkersRef.current.push(markerS);

        // End marker 'E'
        if (ev.endlongitude && ev.endlatitude) {
          const elE = document.createElement('div');
          elE.style.cssText = 'width:20px;height:20px;background:#ef4444;border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:10px;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:pointer;z-index:5;';
          elE.innerText = 'E';
          elE.onclick = (e) => {
            e.stopPropagation();
            if (onEventClickRef.current) {
              onEventClickRef.current({
                id: ev.id,
                event_cause: ev.event_cause,
                zone_type: ev.zone_type,
                priority: ev.priority,
                address: ev.address,
                clearance_mins: ev.current_clearance_time_mins
              });
            }
          };
          const markerE = new maplibregl.Marker({ element: elE })
            .setLngLat([ev.endlongitude, ev.endlatitude])
            .addTo(map);
          activeClosureMarkersRef.current.push(markerE);
        }
      }
    });
  }, [events, mapLoaded]);

  // Update routes and draft closed route
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    const normalSrc = map.getSource('normal-route');
    const safeSrc = map.getSource('safe-route');
    const draftSrc = map.getSource('draft-closed-route');
    const markersSrc = map.getSource('route-markers');

    if (routeData?.normal_route?.geometry) {
      normalSrc?.setData(routeData.normal_route.geometry);
      
      // Add start and end markers
      const coords = routeData.normal_route.geometry.coordinates;
      if (coords && coords.length > 0) {
        const startCoord = coords[0];
        const endCoord = coords[coords.length - 1];
        
        markersSrc?.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: startCoord },
              properties: { label: 'START', color: '#22c55e' }
            },
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: endCoord },
              properties: { label: 'END', color: '#ef4444' }
            }
          ]
        });
      }
    } else {
      normalSrc?.setData(EMPTY_FC);
      markersSrc?.setData(EMPTY_FC);
    }

    if (routeData?.safe_route?.geometry && routeData?.intersects_hazard) {
      safeSrc?.setData(routeData.safe_route.geometry);
    } else {
      safeSrc?.setData(EMPTY_FC);
    }

    if (draftClosedRoute) {
      draftSrc?.setData(draftClosedRoute);
    } else {
      draftSrc?.setData(EMPTY_FC);
    }

    // Fit map to route
    if (routeData?.normal_route?.geometry?.coordinates?.length > 0) {
      const coords = routeData.normal_route.geometry.coordinates;
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 100, duration: 1000 });
    }
  }, [routeData, draftClosedRoute, mapLoaded]);

  // Update GPS location
  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !userLocation) return;
    const src = mapRef.current.getSource('gps-location');
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [userLocation.lng, userLocation.lat] },
          properties: {}
        }]
      });
    }
  }, [userLocation, mapLoaded]);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />
      {mapError && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1000,
          width: '380px',
          padding: '24px',
          textAlign: 'center',
          background: 'rgba(15, 23, 42, 0.9)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(239, 68, 68, 0.4)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
          <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>Map Rendering Error</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '16px' }}>{mapError}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => window.location.reload()} style={{ fontSize: '11px' }}>
            Reload Application
          </button>
        </div>
      )}
    </div>
  );
});

export default MapDashboard;
