import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export default function MiniMap({ lat, lng, endLat, endLng, roadStartLat, roadStartLng, roadEndLat, roadEndLng, routeData, events = [], zoneType, onMapClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const onMapClickRef = useRef(onMapClick);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Keep markers in refs to update them dynamically without recreating the map
  const routeStartMarkerRef = useRef(null);
  const routeEndMarkerRef = useRef(null);
  const roadStartMarkerRef = useRef(null);
  const roadEndMarkerRef = useRef(null);

  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  // 1. Initialize map once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const initialLng = (typeof roadStartLng === 'number' && !isNaN(roadStartLng)) ? roadStartLng : lng || 77.5946;
    const initialLat = (typeof roadStartLat === 'number' && !isNaN(roadStartLat)) ? roadStartLat : lat || 12.9716;

    let map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: MAP_STYLE,
        center: [initialLng, initialLat],
        zoom: 14,
        attributionControl: false,
        maxBounds: [[76.5, 12.2], [78.5, 13.8]]
      });
    } catch (e) {
      console.error('Failed to construct minimap:', e);
      return;
    }

    mapRef.current = map;

    map.on('load', () => {
      // Epicenter source
      map.addSource('epicenter', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [initialLng, initialLat] },
          properties: { label: 'Incident Epicenter' }
        }
      });

      // Yellow epicenter layers for standard events (no road closure)
      map.addLayer({
        id: 'epicenter-glow',
        type: 'circle',
        source: 'epicenter',
        paint: {
          'circle-radius': 14,
          'circle-color': '#f59e0b',
          'circle-opacity': 0,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#f59e0b'
        }
      });

      map.addLayer({
        id: 'epicenter-dot',
        type: 'circle',
        source: 'epicenter',
        paint: {
          'circle-radius': 6,
          'circle-color': '#f59e0b',
          'circle-opacity': 0
        }
      });

      // Active events overlay
      map.addSource('mini-events', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'mini-events-circle',
        type: 'circle',
        source: 'mini-events',
        paint: {
          'circle-radius': 6,
          'circle-color': ['case', ['==', ['get', 'zone_type'], 'Red'], '#ef4444', '#f59e0b'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(255, 255, 255, 0.4)'
        }
      });

      // Normal route
      map.addSource('normal-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'normal-route-line',
        type: 'line',
        source: 'normal-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#3b82f6', 'line-width': 4, 'line-opacity': 0.85 }
      });

      // Safe route (Detour)
      map.addSource('safe-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'safe-route-line',
        type: 'line',
        source: 'safe-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#22c55e', 'line-width': 4, 'line-opacity': 0.85, 'line-dasharray': [2, 2] }
      });

      // Closed route segment
      map.addSource('closed-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'closed-route-line',
        type: 'line',
        source: 'closed-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ef4444', 'line-width': 6, 'line-opacity': 0.95 }
      });

      // Route markers (start and end points)
      map.addSource('route-markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'route-markers-circle',
        type: 'circle',
        source: 'route-markers',
        paint: {
          'circle-radius': 10,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
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
          'text-size': 10,
          'text-offset': [0, 1.8],
          'text-anchor': 'top'
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5
        }
      });
      // Add navigation controls
      map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'bottom-right');

      // Right-click listener for coordinates selection (instantly drop marker)
      map.on('contextmenu', (e) => {
        if (onMapClickRef.current) {
          e.preventDefault();
          onMapClickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng }, 'right');
        }
      });

      setMapLoaded(true);
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      // Clean up markers
      if (routeStartMarkerRef.current) {
        routeStartMarkerRef.current.remove();
        routeStartMarkerRef.current = null;
      }
      if (routeEndMarkerRef.current) {
        routeEndMarkerRef.current.remove();
        routeEndMarkerRef.current = null;
      }
      if (roadStartMarkerRef.current) {
        roadStartMarkerRef.current.remove();
        roadStartMarkerRef.current = null;
      }
      if (roadEndMarkerRef.current) {
        roadEndMarkerRef.current.remove();
        roadEndMarkerRef.current = null;
      }
    };
  }, []);

  // Derive all coordinates for Route pins and Road Closure indicators
  let finalRouteStartLng = lng;
  let finalRouteStartLat = lat;
  let finalRouteEndLng = endLng;
  let finalRouteEndLat = endLat;

  if (routeData?.normal_route?.geometry?.coordinates?.length > 0) {
    const coords = routeData.normal_route.geometry.coordinates;
    finalRouteStartLng = coords[0][0];
    finalRouteStartLat = coords[0][1];
    finalRouteEndLng = coords[coords.length - 1][0];
    finalRouteEndLat = coords[coords.length - 1][1];
  }

  let finalEpicenterLat = lat;
  let finalEpicenterLng = lng;
  let finalRoadEndLat = endLat;
  let finalRoadEndLng = endLng;

  if (typeof roadStartLat === 'number' && !isNaN(roadStartLat) && roadStartLat !== null) {
    finalEpicenterLat = roadStartLat;
    finalEpicenterLng = roadStartLng;
  }
  if (typeof roadEndLat === 'number' && !isNaN(roadEndLat) && roadEndLat !== null) {
    finalRoadEndLat = roadEndLat;
    finalRoadEndLng = roadEndLng;
  }

  // 2. Reactively update sources and markers when props change
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;

    // Update epicenter source
    const epicenterSource = map.getSource('epicenter');
    if (epicenterSource) {
      epicenterSource.setData({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [
            typeof finalEpicenterLng === 'number' ? finalEpicenterLng : 77.5946,
            typeof finalEpicenterLat === 'number' ? finalEpicenterLat : 12.9716
          ]
        },
        properties: { label: 'Incident Epicenter' }
      });
    }

    const isRed = (zoneType && zoneType.toLowerCase() === 'red') || 
                  (typeof roadEndLat === 'number' && !isNaN(roadEndLat) && roadEndLat !== null) ||
                  (routeData?.closed_route ? true : false);
    const epicenterColor = '#f59e0b'; // Always yellow for standard epicenter glow

    if (map.getLayer('epicenter-glow')) {
      map.setPaintProperty('epicenter-glow', 'circle-opacity', isRed ? 0 : 0.3);
      map.setPaintProperty('epicenter-glow', 'circle-stroke-opacity', isRed ? 0 : 1);
      map.setPaintProperty('epicenter-glow', 'circle-color', epicenterColor);
      map.setPaintProperty('epicenter-glow', 'circle-stroke-color', epicenterColor);
    }
    if (map.getLayer('epicenter-dot')) {
      map.setPaintProperty('epicenter-dot', 'circle-opacity', isRed ? 0 : 1);
      map.setPaintProperty('epicenter-dot', 'circle-color', epicenterColor);
    }

    // Update active events source
    const miniEventsSource = map.getSource('mini-events');
    if (miniEventsSource) {
      const features = events.map(ev => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [ev.longitude, ev.latitude]
        },
        properties: {
          zone_type: ev.zone_type,
          id: ev.id
        }
      }));
      miniEventsSource.setData({ type: 'FeatureCollection', features });
    }

    // Update route lines
    const normalSrc = map.getSource('normal-route');
    const markersSrc = map.getSource('route-markers');
    
    if (normalSrc) {
      normalSrc.setData(routeData?.normal_route?.geometry || { type: 'FeatureCollection', features: [] });
      
      // Add start and end markers if route exists
      if (routeData?.normal_route?.geometry?.coordinates?.length > 0) {
        const coords = routeData.normal_route.geometry.coordinates;
        const startCoord = coords[0];
        const endCoord = coords[coords.length - 1];
        
        if (markersSrc) {
          markersSrc.setData({
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
      } else if (markersSrc) {
        markersSrc.setData({ type: 'FeatureCollection', features: [] });
      }
    }
    const safeSrc = map.getSource('safe-route');
    if (safeSrc) {
      safeSrc.setData(routeData?.safe_route?.geometry || { type: 'FeatureCollection', features: [] });
    }
    const closedSrc = map.getSource('closed-route');
    if (closedSrc) {
      closedSrc.setData(routeData?.closed_route?.geometry || { type: 'FeatureCollection', features: [] });
    }

    // --- HTML Markers ---
    
    // a. Route Start Marker (Green Location Pin)
    if (typeof finalRouteStartLat === 'number' && !isNaN(finalRouteStartLat) && finalRouteStartLat !== null &&
        typeof finalRouteStartLng === 'number' && !isNaN(finalRouteStartLng) && finalRouteStartLng !== null) {
      if (!routeStartMarkerRef.current) {
        const elStart = document.createElement('div');
        elStart.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3" fill="#22c55e"></circle>
        </svg>`;
        elStart.style.cursor = 'pointer';
        routeStartMarkerRef.current = new maplibregl.Marker({ element: elStart, anchor: 'bottom' })
          .setLngLat([finalRouteStartLng, finalRouteStartLat])
          .addTo(map);
      } else {
        routeStartMarkerRef.current.setLngLat([finalRouteStartLng, finalRouteStartLat]);
      }
    } else {
      if (routeStartMarkerRef.current) {
        routeStartMarkerRef.current.remove();
        routeStartMarkerRef.current = null;
      }
    }

    // b. Route End Marker (Red Location Pin)
    if (typeof finalRouteEndLat === 'number' && !isNaN(finalRouteEndLat) && finalRouteEndLat !== null &&
        typeof finalRouteEndLng === 'number' && !isNaN(finalRouteEndLng) && finalRouteEndLng !== null) {
      if (!routeEndMarkerRef.current) {
        const elEnd = document.createElement('div');
        elEnd.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3" fill="#ef4444"></circle>
        </svg>`;
        elEnd.style.cursor = 'pointer';
        routeEndMarkerRef.current = new maplibregl.Marker({ element: elEnd, anchor: 'bottom' })
          .setLngLat([finalRouteEndLng, finalRouteEndLat])
          .addTo(map);
      } else {
        routeEndMarkerRef.current.setLngLat([finalRouteEndLng, finalRouteEndLat]);
      }
    } else {
      if (routeEndMarkerRef.current) {
        routeEndMarkerRef.current.remove();
        routeEndMarkerRef.current = null;
      }
    }

    // c. Road Closure Start Marker ('S' red circular marker)
    if (isRed && typeof finalEpicenterLat === 'number' && !isNaN(finalEpicenterLat) && finalEpicenterLat !== null &&
        typeof finalEpicenterLng === 'number' && !isNaN(finalEpicenterLng) && finalEpicenterLng !== null) {
      if (!roadStartMarkerRef.current) {
        const elRoadS = document.createElement('div');
        elRoadS.style.cssText = 'width:20px;height:20px;background:#ef4444;border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:10px;box-shadow:0 2px 6px rgba(0,0,0,0.4);z-index:4;';
        elRoadS.innerText = 'S';
        roadStartMarkerRef.current = new maplibregl.Marker({ element: elRoadS })
          .setLngLat([finalEpicenterLng, finalEpicenterLat])
          .addTo(map);
      } else {
        roadStartMarkerRef.current.setLngLat([finalEpicenterLng, finalEpicenterLat]);
      }
    } else {
      if (roadStartMarkerRef.current) {
        roadStartMarkerRef.current.remove();
        roadStartMarkerRef.current = null;
      }
    }

    // d. Road Closure End Marker ('E' red circular marker)
    if (isRed && typeof finalRoadEndLat === 'number' && !isNaN(finalRoadEndLat) && finalRoadEndLat !== null &&
        typeof finalRoadEndLng === 'number' && !isNaN(finalRoadEndLng) && finalRoadEndLng !== null) {
      if (!roadEndMarkerRef.current) {
        const elRoadE = document.createElement('div');
        elRoadE.style.cssText = 'width:20px;height:20px;background:#ef4444;border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:10px;box-shadow:0 2px 6px rgba(0,0,0,0.4);z-index:4;';
        elRoadE.innerText = 'E';
        roadEndMarkerRef.current = new maplibregl.Marker({ element: elRoadE })
          .setLngLat([finalRoadEndLng, finalRoadEndLat])
          .addTo(map);
      } else {
        roadEndMarkerRef.current.setLngLat([finalRoadEndLng, finalRoadEndLat]);
      }
    } else {
      if (roadEndMarkerRef.current) {
        roadEndMarkerRef.current.remove();
        roadEndMarkerRef.current = null;
      }
    }

    // Fit map bounds if route data is populated
    if (routeData?.normal_route?.geometry?.coordinates?.length > 0) {
      const coords = routeData.normal_route.geometry.coordinates;
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 40, duration: 1000 });
    } else if (routeData?.closed_route?.geometry?.coordinates?.length > 0) {
      const coords = routeData.closed_route.geometry.coordinates;
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 40, duration: 1000 });
    }
  }, [
    mapLoaded,
    finalRouteStartLat,
    finalRouteStartLng,
    finalRouteEndLat,
    finalRouteEndLng,
    finalEpicenterLat,
    finalEpicenterLng,
    finalRoadEndLat,
    finalRoadEndLng,
    routeData,
    zoneType,
    events
  ]);

  const handleRecenter = () => {
    if (mapRef.current) {
      if (routeData?.normal_route?.geometry?.coordinates?.length > 0) {
        const coords = routeData.normal_route.geometry.coordinates;
        const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
        mapRef.current.fitBounds(bounds, { padding: 40, duration: 1500 });
      } else {
        const centerLat = finalEpicenterLat || lat || 12.9716;
        const centerLng = finalEpicenterLng || lng || 77.5946;
        mapRef.current.flyTo({ center: [centerLng, centerLat], zoom: 14, duration: 1500 });
      }
    }
  };

  return (
    <div 
      className="minimap-container" 
      onContextMenu={(e) => e.preventDefault()}
      style={{ 
        width: '100%', 
        height: '260px', 
        borderRadius: 'var(--radius)', 
        border: '1px solid var(--border)',
        overflow: 'hidden',
        position: 'relative',
        marginTop: '16px',
        marginBottom: '16px'
      }} 
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <button
        type="button"
        onClick={handleRecenter}
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 10,
          background: 'rgba(15, 23, 42, 0.85)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '8px',
          width: '32px',
          height: '32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: 'var(--text-primary)',
          backdropFilter: 'blur(4px)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          transition: 'all 0.2s ease',
        }}
        title="Recenter Epicenter"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
        </svg>
      </button>
    </div>
  );
}
