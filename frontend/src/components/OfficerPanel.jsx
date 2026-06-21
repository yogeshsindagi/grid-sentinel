import { useState, useEffect } from 'react';
import { X, Plus, CheckCircle, XCircle, Clock, MapPin, AlertTriangle, Shield, ChevronDown, ChevronUp, Send, Zap, Compass, Navigation, Calculator, Search } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSpinner from './LoadingSpinner';
import MiniMap from './MiniMap';

const EVENT_CAUSES = [
  'vehicle_breakdown', 'accident', 'water_logging', 'tree_fall', 'construction',
  'road_conditions', 'debris', 'congestion', 'pot_holes', 'public_event',
  'vip_movement', 'procession', 'protest', 'others'
];

const PRIORITIES = ['High', 'Medium', 'Low'];

const CORRIDORS = [
  'Non-corridor',
  'Mysore Road',
  'Bellary Road',
  'Tumkur Road',
  'Hosur Road',
  'Outer Ring Road',
  'Old Madras Road',
  'Magadi Road',
  'Sarjapur Road',
  'Bannerghatta Road'
];

export default function OfficerPanel({ 
  events = [], 
  reports = [], 
  selectedEventId,
  mapEventStartCoords,
  mapEventEndCoords,
  onClearEventStartCoords,
  onClearEventEndCoords,
  onClose, 
  onRefresh, 
  onShowAiSuggestion, 
  onSetRouteData, 
  onSetDraftClosedRoute,
  userLocation, 
  onLocateOnMap, 
  onStartMapSelect,
  isServiceAllowed = () => true,
  isServiceLimited = () => false,
  aiSuggestionAttempts = [],
  aiSuggestionTimeLeft = null,
  onRecordAttempt
}) {
  const [activeTab, setActiveTab] = useState('create'); // create, events, reports
  const [reportsSubTab, setReportsSubTab] = useState('active'); // active, closed
  const [form, setForm] = useState({
    event_cause: 'others', latitude: '', longitude: '', address: '',
    requires_road_closure: false, priority: 'Medium', veh_type: '',
    initial_clearance_time_mins: '', description: '',
    corridor: 'Non-corridor', endlatitude: '', endlongitude: ''
  });
  const [loading, setLoading] = useState(false);
  const [snoozeId, setSnoozeId] = useState(null);
  const [snoozeMins, setSnoozeMins] = useState(30);

  // AI analysis states
  const [analyzingReportId, setAnalyzingReportId] = useState(null);
  const [analysisResults, setAnalysisResults] = useState({});
  const [tempSuggestions, setTempSuggestions] = useState(null);
  const [showCalculatorDialog, setShowCalculatorDialog] = useState(false);
  const [calculatingClearance, setCalculatingClearance] = useState(false);

  // AI Pre-Suggestion Location Selector States
  const [showLocationSelector, setShowLocationSelector] = useState(false);
  const [startLocName, setStartLocName] = useState('');
  const [endLocName, setEndLocName] = useState('');
  const [isGeocodingStart, setIsGeocodingStart] = useState(false);
  const [isGeocodingEnd, setIsGeocodingEnd] = useState(false);
  const [waitingForMapSelectMode, setWaitingForMapSelectMode] = useState(null); // 'start' | 'end' | null
  const [selectorClosedRoute, setSelectorClosedRoute] = useState(null);
  const [activePlacementMode, setActivePlacementMode] = useState(null); // 'start' | 'end' | null
  const [routeStartLat, setRouteStartLat] = useState('');
  const [routeStartLng, setRouteStartLng] = useState('');
  const [routeEndLat, setRouteEndLat] = useState('');
  const [routeEndLng, setRouteEndLng] = useState('');

  // Helper geocoding functions
  const geocodeAddress = async (query) => {
    if (!query) return null;
    const q = query.toLowerCase().trim();
    const coordRegex = /^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/;
    const match = q.match(coordRegex);
    if (match) {
      return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
    }
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ', Bengaluru')}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'GridLock-Sentinel' } });
      const data = await res.json();
      if (data && data.length > 0) {
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      }
    } catch (e) {
      console.error('Geocode error:', e);
    }
    return null;
  };

  const reverseGeocode = async (lat, lon) => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'GridLock-Sentinel' } });
      const data = await res.json();
      if (data && data.address) {
        const addr = data.address;
        const road = addr.road || addr.suburb || addr.neighbourhood || '';
        const city = addr.city || addr.town || addr.county || '';
        const display = [road, city].filter(Boolean).join(', ');
        return display || data.display_name.split(',').slice(0, 2).join(', ').trim();
      }
    } catch (e) {
      console.error('Reverse geocode error:', e);
    }
    return '';
  };

  // Switch to events tab and scroll to selected card
  useEffect(() => {
    if (selectedEventId) {
      setActiveTab('events');
      const timer = setTimeout(() => {
        const element = document.getElementById(`officer-event-card-${selectedEventId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [selectedEventId]);



  useEffect(() => {
    if (mapEventStartCoords) {
      const latVal = mapEventStartCoords.lat;
      const lngVal = mapEventStartCoords.lng;
      setForm(prev => ({
        ...prev,
        latitude: latVal.toString(),
        longitude: lngVal.toString()
      }));
      reverseGeocode(latVal, lngVal).then(addr => {
        if (addr) {
          setForm(prev => ({
            ...prev,
            address: addr
          }));
        }
      });
      if (onClearEventStartCoords) {
        onClearEventStartCoords();
      }
    }
  }, [mapEventStartCoords, onClearEventStartCoords]);

  useEffect(() => {
    if (mapEventEndCoords) {
      setForm(prev => ({
        ...prev,
        endlatitude: mapEventEndCoords.lat.toString(),
        endlongitude: mapEventEndCoords.lng.toString()
      }));
      if (onClearEventEndCoords) {
        onClearEventEndCoords();
      }
    }
  }, [mapEventEndCoords, onClearEventEndCoords]);

  // Geocode address when route coords change
  useEffect(() => {
    const lat = parseFloat(routeStartLat);
    const lng = parseFloat(routeStartLng);
    if (!isNaN(lat) && !isNaN(lng)) {
      reverseGeocode(lat, lng).then(addr => {
        if (addr) setStartLocName(addr);
      });
    }
  }, [routeStartLat, routeStartLng]);

  useEffect(() => {
    const lat = parseFloat(routeEndLat);
    const lng = parseFloat(routeEndLng);
    if (!isNaN(lat) && !isNaN(lng)) {
      reverseGeocode(lat, lng).then(addr => {
        if (addr) setEndLocName(addr);
      });
    }
  }, [routeEndLat, routeEndLng]);

  // Reopen coordinates selector when coordinates are updated via main map click
  useEffect(() => {
    if (waitingForMapSelectMode === 'start' && form.latitude && form.longitude) {
      setWaitingForMapSelectMode(null);
      setShowLocationSelector(true);
    }
  }, [form.latitude, form.longitude, waitingForMapSelectMode]);

  useEffect(() => {
    if (waitingForMapSelectMode === 'end' && form.endlatitude && form.endlongitude) {
      setWaitingForMapSelectMode(null);
      setShowLocationSelector(true);
    }
  }, [form.endlatitude, form.endlongitude, waitingForMapSelectMode]);

  // Fetch route between start & end coordinates for preview MiniMap inside selector dialog
  useEffect(() => {
    const startLat = parseFloat(form.latitude);
    const startLon = parseFloat(form.longitude);
    const endLat = parseFloat(form.endlatitude);
    const endLon = parseFloat(form.endlongitude);

    if (form.requires_road_closure && !isNaN(startLat) && !isNaN(startLon) && !isNaN(endLat) && !isNaN(endLon)) {
      let active = true;
      api.getRoute(startLat, startLon, endLat, endLon)
        .then(res => {
          if (active && res.success && res.geometry) {
            setSelectorClosedRoute(res.geometry);
          }
        })
        .catch(err => {
          console.warn("Failed to fetch selector route segment:", err);
        });
      return () => {
        active = false;
      };
    } else {
      setSelectorClosedRoute(null);
    }
  }, [form.latitude, form.longitude, form.endlatitude, form.endlongitude, form.requires_road_closure]);

  // Watcher to reset AI suggestions when any form configuration is changed
  useEffect(() => {
    if (tempSuggestions) {
      const normalizeFloat = (val) => {
        if (val === null || val === undefined || val === '') return null;
        const f = parseFloat(val);
        return isNaN(f) ? null : f;
      };

      const formLat = normalizeFloat(form.latitude);
      const formLng = normalizeFloat(form.longitude);
      const formEndLat = normalizeFloat(form.endlatitude);
      const formEndLng = normalizeFloat(form.endlongitude);
      
      const routeStartLatVal = normalizeFloat(routeStartLat);
      const routeStartLngVal = normalizeFloat(routeStartLng);
      const routeEndLatVal = normalizeFloat(routeEndLat);
      const routeEndLngVal = normalizeFloat(routeEndLng);

      const cacheLat = normalizeFloat(tempSuggestions.latitude);
      const cacheLng = normalizeFloat(tempSuggestions.longitude);
      const cacheEndLat = normalizeFloat(tempSuggestions.endlatitude);
      const cacheEndLng = normalizeFloat(tempSuggestions.endlongitude);
      
      const cacheRouteStartLat = normalizeFloat(tempSuggestions.route_start_latitude);
      const cacheRouteStartLng = normalizeFloat(tempSuggestions.route_start_longitude);
      const cacheRouteEndLat = normalizeFloat(tempSuggestions.route_end_latitude);
      const cacheRouteEndLng = normalizeFloat(tempSuggestions.route_end_longitude);

      const isDifferent =
        form.event_cause !== tempSuggestions.event_cause ||
        formLat !== cacheLat ||
        formLng !== cacheLng ||
        formEndLat !== cacheEndLat ||
        formEndLng !== cacheEndLng ||
        routeStartLatVal !== cacheRouteStartLat ||
        routeStartLngVal !== cacheRouteStartLng ||
        routeEndLatVal !== cacheRouteEndLat ||
        routeEndLngVal !== cacheRouteEndLng ||
        form.requires_road_closure !== tempSuggestions.requires_road_closure ||
        form.priority !== tempSuggestions.priority ||
        form.veh_type !== (tempSuggestions.veh_type || '') ||
        form.initial_clearance_time_mins.toString() !== (tempSuggestions.initial_clearance_time_mins || '').toString() ||
        form.description !== (tempSuggestions.description || '') ||
        form.corridor !== (tempSuggestions.corridor || 'Non-corridor');

      if (isDifferent) {
        setTempSuggestions(null);
        if (onSetRouteData) onSetRouteData(null);
        if (onSetDraftClosedRoute) onSetDraftClosedRoute(null);
        if (onShowAiSuggestion) onShowAiSuggestion(null);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.event_cause,
    form.latitude,
    form.longitude,
    form.endlatitude,
    form.endlongitude,
    routeStartLat,
    routeStartLng,
    routeEndLat,
    routeEndLng,
    form.requires_road_closure,
    form.priority,
    form.veh_type,
    form.initial_clearance_time_mins,
    form.description,
    form.corridor,
    tempSuggestions,
    onSetRouteData,
    onSetDraftClosedRoute,
    onShowAiSuggestion
  ]);


  // Hook to fetch and draw the draft route between start and end coordinates
  useEffect(() => {
    const startLat = parseFloat(form.latitude);
    const startLon = parseFloat(form.longitude);
    const endLat = parseFloat(form.endlatitude);
    const endLon = parseFloat(form.endlongitude);

    if (form.requires_road_closure && !isNaN(startLat) && !isNaN(startLon) && !isNaN(endLat) && !isNaN(endLon)) {
      let active = true;
      api.getRoute(startLat, startLon, endLat, endLon)
        .then(res => {
          if (active && res.success && res.geometry) {
            if (onSetDraftClosedRoute) {
              onSetDraftClosedRoute(res.geometry);
            }
          }
        })
        .catch(err => {
          console.warn("Failed to fetch draft route segment:", err);
        });
      return () => {
        active = false;
      };
    } else {
      if (onSetDraftClosedRoute) {
        onSetDraftClosedRoute(null);
      }
    }
  }, [form.latitude, form.longitude, form.endlatitude, form.endlongitude, form.requires_road_closure, onSetDraftClosedRoute]);

  const lat = form.latitude;
  const lng = form.longitude;

  const handleUseGps = () => {
    if (userLocation) {
      setForm(prev => ({
        ...prev,
        latitude: userLocation.lat.toFixed(6),
        longitude: userLocation.lng.toFixed(6)
      }));
      reverseGeocode(userLocation.lat, userLocation.lng).then(addr => {
        if (addr) {
          setForm(prev => ({
            ...prev,
            address: addr
          }));
        }
      });
      if (onLocateOnMap) {
        onLocateOnMap(userLocation.lat, userLocation.lng, false);
      }
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const latVal = pos.coords.latitude;
          const lngVal = pos.coords.longitude;
          setForm(prev => ({
            ...prev,
            latitude: latVal.toFixed(6),
            longitude: lngVal.toFixed(6)
          }));
          reverseGeocode(latVal, lngVal).then(addr => {
            if (addr) {
              setForm(prev => ({
                ...prev,
                address: addr
              }));
            }
          });
          if (onLocateOnMap) {
            onLocateOnMap(latVal, lngVal, false);
          }
        },
        () => alert('Could not get your location. Please check location permissions.'),
        { enableHighAccuracy: true }
      );
    } else {
      alert("GPS location is not available.");
    }
  };
 
  const handleUseGpsEnd = () => {
    if (userLocation) {
      setForm(prev => ({
        ...prev,
        endlatitude: userLocation.lat.toFixed(6),
        endlongitude: userLocation.lng.toFixed(6)
      }));
      if (onLocateOnMap) {
        onLocateOnMap(userLocation.lat, userLocation.lng, false);
      }
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const latVal = pos.coords.latitude;
          const lngVal = pos.coords.longitude;
          setForm(prev => ({
            ...prev,
            endlatitude: latVal.toFixed(6),
            endlongitude: lngVal.toFixed(6)
          }));
          if (onLocateOnMap) {
            onLocateOnMap(latVal, lngVal, false);
          }
        },
        () => alert('Could not get your location. Please check location permissions.'),
        { enableHighAccuracy: true }
      );
    } else {
      alert("GPS location is not available.");
    }
  };

  const handleLocateClick = () => {
    if (onStartMapSelect) {
      onStartMapSelect('create_event');
    }
  };

  const handleLocateClickEnd = () => {
    if (onStartMapSelect) {
      onStartMapSelect('create_event_end');
    }
  };

  const handleClearForm = () => {
    setForm({
      event_cause: 'others',
      latitude: '',
      longitude: '',
      address: '',
      requires_road_closure: false,
      priority: 'Medium',
      veh_type: '',
      initial_clearance_time_mins: '',
      description: '',
      corridor: 'Non-corridor',
      endlatitude: '',
      endlongitude: ''
    });
    setTempSuggestions(null);
  };

  const handleStartSearch = async () => {
    if (!startLocName) return;
    setIsGeocodingStart(true);
    const coords = await geocodeAddress(startLocName);
    setIsGeocodingStart(false);
    if (coords) {
      setForm(prev => ({
        ...prev,
        latitude: coords.lat.toFixed(6),
        longitude: coords.lng.toFixed(6)
      }));
    } else {
      alert("Could not locate the entered address in Bengaluru.");
    }
  };

  const handleEndSearch = async () => {
    if (!endLocName) return;
    setIsGeocodingEnd(true);
    const coords = await geocodeAddress(endLocName);
    setIsGeocodingEnd(false);
    if (coords) {
      setForm(prev => ({
        ...prev,
        endlatitude: coords.lat.toFixed(6),
        endlongitude: coords.lng.toFixed(6)
      }));
    } else {
      alert("Could not locate the entered address in Bengaluru.");
    }
  };

  const handleDialogMapClick = (coords, clickType) => {
    if (clickType === 'right') {
      if (activePlacementMode === 'end') {
        setRouteEndLat(coords.lat.toFixed(6));
        setRouteEndLng(coords.lng.toFixed(6));
        reverseGeocode(coords.lat, coords.lng).then(addr => {
          if (addr) setEndLocName(addr);
        });
        setActivePlacementMode(null);
      } else if (activePlacementMode === 'start') {
        setRouteStartLat(coords.lat.toFixed(6));
        setRouteStartLng(coords.lng.toFixed(6));
        reverseGeocode(coords.lat, coords.lng).then(addr => {
          if (addr) setStartLocName(addr);
        });
        setActivePlacementMode(null);
      }
    }
  };

  const handleAiSuggestionClick = () => {
    if (!isServiceAllowed('ai_suggestion')) {
      alert("AI Suggestions has been disabled by the system administrator.");
      return;
    }
    
    if (form.requires_road_closure) {
      // Pre-populate route start & end from form coordinates
      setRouteStartLat(form.latitude || '');
      setRouteStartLng(form.longitude || '');
      setRouteEndLat(form.endlatitude || '');
      setRouteEndLng(form.endlongitude || '');

      // Pre-populate input names if coords exist
      if (form.latitude && form.longitude) {
        reverseGeocode(parseFloat(form.latitude), parseFloat(form.longitude)).then(addr => {
          if (addr) setStartLocName(addr);
        });
      } else {
        setStartLocName('');
      }
      if (form.endlatitude && form.endlongitude) {
        reverseGeocode(parseFloat(form.endlatitude), parseFloat(form.endlongitude)).then(addr => {
          if (addr) setEndLocName(addr);
        });
      } else {
        setEndLocName('');
      }
    } else {
      // For single location event, do not pre-populate start or end locations
      setRouteStartLat('');
      setRouteStartLng('');
      setRouteEndLat('');
      setRouteEndLng('');
      setStartLocName('');
      setEndLocName('');
    }
    setShowLocationSelector(true);
  };

  const executeGenerateAiSuggestion = async () => {
    if (!form.latitude || !form.longitude) {
      alert("Please fill Latitude and Longitude first.");
      return;
    }
    if (form.requires_road_closure) {
      if (!form.endlatitude || !form.endlongitude || isNaN(parseFloat(form.endlatitude)) || isNaN(parseFloat(form.endlongitude))) {
        alert("End Latitude and End Longitude are mandatory when road closure is required.");
        return;
      }
    }
    
    if (
      tempSuggestions &&
      tempSuggestions.latitude === parseFloat(form.latitude) &&
      tempSuggestions.longitude === parseFloat(form.longitude) &&
      tempSuggestions.endlatitude === (form.endlatitude ? parseFloat(form.endlatitude) : null) &&
      tempSuggestions.endlongitude === (form.endlongitude ? parseFloat(form.endlongitude) : null) &&
      tempSuggestions.route_start_latitude === (routeStartLat ? parseFloat(routeStartLat) : null) &&
      tempSuggestions.route_start_longitude === (routeStartLng ? parseFloat(routeStartLng) : null) &&
      tempSuggestions.route_end_latitude === (routeEndLat ? parseFloat(routeEndLat) : null) &&
      tempSuggestions.route_end_longitude === (routeEndLng ? parseFloat(routeEndLng) : null) &&
      tempSuggestions.requires_road_closure === form.requires_road_closure &&
      tempSuggestions.event_cause === form.event_cause &&
      tempSuggestions.priority === form.priority &&
      tempSuggestions.veh_type === form.veh_type &&
      tempSuggestions.initial_clearance_time_mins.toString() === form.initial_clearance_time_mins.toString() &&
      tempSuggestions.description === form.description &&
      tempSuggestions.corridor === form.corridor
    ) {
      if (onShowAiSuggestion) {
        onShowAiSuggestion({
          id: 'Draft',
          event_cause: tempSuggestions.event_cause || form.event_cause,
          address: tempSuggestions.address || form.address,
          priority: tempSuggestions.priority || form.priority,
          zone_type: form.requires_road_closure ? 'Red' : 'Yellow',
          confidence_score: tempSuggestions.confidence_score,
          support_text: tempSuggestions.support_text,
          markdown_content: tempSuggestions.markdown_content,
          latitude: parseFloat(form.latitude),
          longitude: parseFloat(form.longitude),
          endlatitude: tempSuggestions.endlatitude,
          endlongitude: tempSuggestions.endlongitude,
          route_start_latitude: tempSuggestions.route_start_latitude,
          route_start_longitude: tempSuggestions.route_start_longitude,
          route_end_latitude: tempSuggestions.route_end_latitude,
          route_end_longitude: tempSuggestions.route_end_longitude,
          routeData: tempSuggestions.detour_route_geojson ? JSON.parse(tempSuggestions.detour_route_geojson) : null,
          requires_road_closure: form.requires_road_closure,
          delay_mins: tempSuggestions.delay_mins || 0
        });
        setShowLocationSelector(false);
      }
      return;
    }

    if (!isServiceAllowed('ai_suggestion')) {
      alert("AI Suggestions has been disabled by the system administrator.");
      return;
    }

    if (isServiceLimited('ai_suggestion')) {
      const now = Date.now();
      const windowMs = 10 * 60 * 1000;
      const filtered = (aiSuggestionAttempts || []).filter(t => now - t < windowMs);
      if (filtered.length >= 3) {
        alert("AI suggestions limit reached. You can request 3 recommendations per 10-minute window.");
        return;
      }
    }

    setLoading(true);
    try {
      const payload = {
        event_cause: form.event_cause,
        latitude: parseFloat(form.latitude),
        longitude: parseFloat(form.longitude),
        address: form.address,
        requires_road_closure: form.requires_road_closure,
        priority: form.priority,
        veh_type: form.veh_type,
        initial_clearance_time_mins: parseInt(form.initial_clearance_time_mins) || 30,
        description: form.description,
        endlatitude: form.endlatitude ? parseFloat(form.endlatitude) : null,
        endlongitude: form.endlongitude ? parseFloat(form.endlongitude) : null,
        route_start_latitude: routeStartLat ? parseFloat(routeStartLat) : null,
        route_start_longitude: routeStartLng ? parseFloat(routeStartLng) : null,
        route_end_latitude: routeEndLat ? parseFloat(routeEndLat) : null,
        route_end_longitude: routeEndLng ? parseFloat(routeEndLng) : null
      };
      
      const data = await api.previewSuggestions(payload);

      const finalCause = data.parsed_fields?.event_cause || form.event_cause;
      const finalAddress = form.address || data.parsed_fields?.address || '';
      const finalLatitude = parseFloat(form.latitude);
      const finalLongitude = parseFloat(form.longitude);
      const finalRoadClosure = data.parsed_fields?.requires_road_closure !== undefined 
        ? data.parsed_fields.requires_road_closure 
        : form.requires_road_closure;
      const finalPriority = data.parsed_fields?.priority || form.priority;
      const finalVehType = form.veh_type || data.parsed_fields?.veh_type || '';
      const finalClearance = data.parsed_fields?.initial_clearance_time_mins !== undefined && data.parsed_fields?.initial_clearance_time_mins !== null
        ? data.parsed_fields.initial_clearance_time_mins.toString()
        : (form.initial_clearance_time_mins ? form.initial_clearance_time_mins.toString() : '');
      const finalDescription = form.description || '';
      const finalCorridor = data.parsed_fields?.corridor || form.corridor || 'Non-corridor';
      const finalEndLatitude = form.endlatitude 
        ? parseFloat(form.endlatitude) 
        : (data.parsed_fields?.endlatitude !== undefined && data.parsed_fields?.endlatitude !== null ? parseFloat(data.parsed_fields.endlatitude) : null);
      const finalEndLongitude = form.endlongitude 
        ? parseFloat(form.endlongitude) 
        : (data.parsed_fields?.endlongitude !== undefined && data.parsed_fields?.endlongitude !== null ? parseFloat(data.parsed_fields.endlongitude) : null);
      
      setTempSuggestions({
        event_cause: finalCause,
        address: finalAddress,
        priority: finalPriority,
        confidence_score: data.confidence_score,
        support_text: data.support_text,
        markdown_content: data.markdown_content,
        officer_suggestions: data.officer_suggestions,
        traveler_suggestions: data.traveler_suggestions,
        detour_route_geojson: data.detour_route_geojson,
        latitude: finalLatitude,
        longitude: finalLongitude,
        endlatitude: finalEndLatitude,
        endlongitude: finalEndLongitude,
        route_start_latitude: routeStartLat ? parseFloat(routeStartLat) : null,
        route_start_longitude: routeStartLng ? parseFloat(routeStartLng) : null,
        route_end_latitude: routeEndLat ? parseFloat(routeEndLat) : null,
        route_end_longitude: routeEndLng ? parseFloat(routeEndLng) : null,
        requires_road_closure: finalRoadClosure,
        veh_type: finalVehType,
        initial_clearance_time_mins: finalClearance,
        description: finalDescription,
        corridor: finalCorridor,
        delay_mins: data.delay_mins || 0
      });

      if (isServiceLimited('ai_suggestion') && onRecordAttempt) {
        const now = Date.now();
        const windowMs = 10 * 60 * 1000;
        const filtered = (aiSuggestionAttempts || []).filter(t => now - t < windowMs);
        onRecordAttempt('ai_suggestion', [...filtered, now]);
      }

      if (data.parsed_fields) {
        setForm(prev => ({
          ...prev,
          address: finalAddress,
          requires_road_closure: finalRoadClosure,
          priority: finalPriority,
          veh_type: finalVehType,
          initial_clearance_time_mins: finalClearance,
          description: finalDescription,
          corridor: finalCorridor,
          endlatitude: finalEndLatitude !== null ? finalEndLatitude.toString() : '',
          endlongitude: finalEndLongitude !== null ? finalEndLongitude.toString() : ''
        }));
      }

      if (onShowAiSuggestion) {
        onShowAiSuggestion({
          id: 'Draft',
          event_cause: finalCause,
          address: finalAddress,
          priority: finalPriority,
          zone_type: finalRoadClosure ? 'Red' : 'Yellow',
          confidence_score: data.confidence_score,
          support_text: data.support_text,
          markdown_content: data.markdown_content,
          latitude: finalLatitude,
          longitude: finalLongitude,
          endlatitude: finalEndLatitude,
          endlongitude: finalEndLongitude,
          route_start_latitude: routeStartLat ? parseFloat(routeStartLat) : null,
          route_start_longitude: routeStartLng ? parseFloat(routeStartLng) : null,
          route_end_latitude: routeEndLat ? parseFloat(routeEndLat) : null,
          route_end_longitude: routeEndLng ? parseFloat(routeEndLng) : null,
          routeData: data.detour_route_geojson ? JSON.parse(data.detour_route_geojson) : null,
          requires_road_closure: finalRoadClosure,
          delay_mins: data.delay_mins || 0
        });
        setShowLocationSelector(false);
      }
    } catch (e) {
      alert("Failed to get AI suggestions: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCalculateClick = () => {
    if (!form.latitude || !form.longitude) {
      alert("Please enter Latitude and Longitude first to calculate clearance time.");
      return;
    }
    if (form.requires_road_closure) {
      if (!form.endlatitude || !form.endlongitude || isNaN(parseFloat(form.endlatitude)) || isNaN(parseFloat(form.endlongitude))) {
        alert("End Latitude and End Longitude are mandatory when road closure is required.");
        return;
      }
    }
    setShowCalculatorDialog(true);
  };

  const handleConfirmCalculation = async () => {
    setCalculatingClearance(true);
    try {
      const payload = {
        event_cause: form.event_cause,
        latitude: parseFloat(form.latitude),
        longitude: parseFloat(form.longitude),
        requires_road_closure: form.requires_road_closure,
        veh_type: form.veh_type || 'unknown',
        address: form.address,
        description: form.description,
        endlatitude: form.endlatitude ? parseFloat(form.endlatitude) : null,
        endlongitude: form.endlongitude ? parseFloat(form.endlongitude) : null
      };
      
      const data = await api.calculateClearance(payload);
      
      setForm(prev => ({
        ...prev,
        initial_clearance_time_mins: data.predicted_clearance_time_mins
      }));
      
      setShowCalculatorDialog(false);
    } catch (e) {
      alert("Failed to calculate clearance time: " + e.message);
    } finally {
      setCalculatingClearance(false);
    }
  };

  const handleCreate = async () => {
    if (!lat || !lng) { alert('Please set latitude and longitude'); return; }
    if (form.requires_road_closure) {
      if (!form.endlatitude || !form.endlongitude || isNaN(parseFloat(form.endlatitude)) || isNaN(parseFloat(form.endlongitude))) {
        alert("End Latitude and End Longitude are mandatory when road closure is required.");
        return;
      }
    }
    const clearanceTime = parseInt(form.initial_clearance_time_mins);
    if (!form.initial_clearance_time_mins || isNaN(clearanceTime) || clearanceTime <= 0) {
      alert("Please enter a valid positive clearance time (in minutes) before creating the event.");
      return;
    }
    setLoading(true);
    try {
      const payload = {
        ...form,
        latitude: parseFloat(lat),
        longitude: parseFloat(lng),
        initial_clearance_time_mins: clearanceTime,
        endlatitude: form.endlatitude ? parseFloat(form.endlatitude) : null,
        endlongitude: form.endlongitude ? parseFloat(form.endlongitude) : null,
        ...(tempSuggestions ? {
          officer_suggestions: tempSuggestions.officer_suggestions,
          traveler_suggestions: tempSuggestions.traveler_suggestions,
          detour_route_geojson: tempSuggestions.detour_route_geojson
        } : {})
      };
      await api.createEvent(payload);
      handleClearForm();
      if (onRefresh) onRefresh();
      setActiveTab('events');
    } catch (e) {
      alert('Failed to create event: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (id) => {
    try { await api.resolveEvent(id); if (onRefresh) await onRefresh(); } catch (e) { alert(e.message); }
  };

  const handleSnooze = async (id) => {
    try { await api.snoozeEvent(id, parseInt(snoozeMins) || 30); setSnoozeId(null); if (onRefresh) await onRefresh(); } catch (e) { alert(e.message); }
  };

  const handleReportStatus = async (id, status) => {
    try { await api.updateReportStatus(id, status); if (onRefresh) await onRefresh(); } catch (e) { alert(e.message); }
  };

  const handleAnalyzeReport = async (reportId) => {
    setAnalyzingReportId(reportId);
    try {
      const data = await api.analyzeReport(reportId);
      setAnalysisResults(prev => ({ ...prev, [reportId]: data }));
    } catch (e) {
      alert("Failed to analyze report: " + e.message);
    } finally {
      setAnalyzingReportId(null);
    }
  };

  const handleVerifyAndProceed = async (reportId) => {
    const analysis = analysisResults[reportId];
    if (!analysis) return;
    
    try {
      // 1. Bulk verify all supporting reports
      await api.verifyReportsBulk(analysis.supporting_ids);

      const finalEndLatVal = analysis.parsed_fields.endlatitude !== undefined && analysis.parsed_fields.endlatitude !== null ? parseFloat(analysis.parsed_fields.endlatitude) : null;
      const finalEndLngVal = analysis.parsed_fields.endlongitude !== undefined && analysis.parsed_fields.endlongitude !== null ? parseFloat(analysis.parsed_fields.endlongitude) : null;
      const finalClearanceVal = analysis.parsed_fields.initial_clearance_time_mins !== undefined && analysis.parsed_fields.initial_clearance_time_mins !== null
        ? analysis.parsed_fields.initial_clearance_time_mins.toString()
        : '';
      
      // 2. Set temporary suggestions state to save when Create Event is clicked
      setTempSuggestions({
        confidence_score: analysis.confidence_score,
        support_text: analysis.support_text,
        markdown_content: analysis.markdown_content,
        officer_suggestions: analysis.officer_suggestions,
        traveler_suggestions: analysis.traveler_suggestions,
        detour_route_geojson: analysis.detour_route_geojson,
        event_cause: analysis.parsed_fields.event_cause,
        latitude: parseFloat(analysis.parsed_fields.latitude),
        longitude: parseFloat(analysis.parsed_fields.longitude),
        endlatitude: finalEndLatVal,
        endlongitude: finalEndLngVal,
        requires_road_closure: analysis.parsed_fields.requires_road_closure,
        address: analysis.parsed_fields.address || '',
        priority: analysis.parsed_fields.priority,
        veh_type: analysis.parsed_fields.veh_type || '',
        initial_clearance_time_mins: finalClearanceVal,
        description: analysis.parsed_fields.description || '',
        corridor: analysis.parsed_fields.corridor || 'Non-corridor',
        delay_mins: analysis.delay_mins || 0
      });
      
      // 3. Pre-fill the event creation form
      setForm({
        event_cause: analysis.parsed_fields.event_cause,
        latitude: analysis.parsed_fields.latitude.toString(),
        longitude: analysis.parsed_fields.longitude.toString(),
        address: analysis.parsed_fields.address || '',
        requires_road_closure: analysis.parsed_fields.requires_road_closure,
        priority: analysis.parsed_fields.priority,
        veh_type: analysis.parsed_fields.veh_type || '',
        initial_clearance_time_mins: finalClearanceVal,
        description: analysis.parsed_fields.description || '',
        corridor: analysis.parsed_fields.corridor || 'Non-corridor',
        endlatitude: finalEndLatVal !== null ? finalEndLatVal.toString() : '',
        endlongitude: finalEndLngVal !== null ? finalEndLngVal.toString() : ''
      });
      
      
      // 5. Open central AI suggestions modal with interactive map preview
      if (onShowAiSuggestion) {
        onShowAiSuggestion({
          id: 'Draft',
          event_cause: analysis.parsed_fields.event_cause,
          address: analysis.parsed_fields.address || '',
          priority: analysis.parsed_fields.priority,
          zone_type: analysis.parsed_fields.requires_road_closure ? 'Red' : 'Yellow',
          confidence_score: analysis.confidence_score,
          support_text: analysis.support_text,
          markdown_content: analysis.markdown_content,
          latitude: analysis.parsed_fields.latitude,
          longitude: analysis.parsed_fields.longitude,
          endlatitude: finalEndLatVal,
          endlongitude: finalEndLngVal,
          routeData: analysis.detour_route_geojson ? JSON.parse(analysis.detour_route_geojson) : null,
          requires_road_closure: analysis.parsed_fields.requires_road_closure,
          delay_mins: analysis.delay_mins || 0
        });
      }
      
      // 6. Refresh parent lists (to remove verified reports)
      if (onRefresh) await onRefresh();
      
      // 7. Switch active tab to "create"
      setActiveTab('create');
    } catch (e) {
      alert("Failed to verify & proceed: " + e.message);
    }
  };

  const handleShowSavedSuggestion = async (ev) => {
    if (!isServiceAllowed('ai_suggestion')) {
      alert("AI Suggestions has been disabled by the system administrator.");
      return;
    }

    if (isServiceLimited('ai_suggestion')) {
      const now = Date.now();
      const windowMs = 10 * 60 * 1000;
      const filtered = (aiSuggestionAttempts || []).filter(t => now - t < windowMs);
      if (filtered.length >= 3) {
        alert("AI suggestions limit reached. You can request 3 recommendations per 10-minute window.");
        return;
      }
    }

    try {
      const data = await api.getEventSuggestions(ev.id);
      
      if (isServiceLimited('ai_suggestion') && onRecordAttempt) {
        const now = Date.now();
        const windowMs = 10 * 60 * 1000;
        const filtered = (aiSuggestionAttempts || []).filter(t => now - t < windowMs);
        onRecordAttempt('ai_suggestion', [...filtered, now]);
      }

      if (onShowAiSuggestion) {
        onShowAiSuggestion({
          id: ev.id,
          event_cause: data.event_cause || ev.event_cause,
          address: data.address || ev.address,
          priority: ev.priority,
          zone_type: ev.zone_type || data.zone_type,
          confidence_score: data.confidence_score,
          support_text: data.support_text,
          markdown_content: data.markdown_content,
          latitude: data.latitude,
          longitude: data.longitude,
          endlatitude: data.endlatitude !== undefined ? data.endlatitude : ev.endlatitude,
          endlongitude: data.endlongitude !== undefined ? data.endlongitude : ev.endlongitude,
          routeData: data.routeData,
          requires_road_closure: data.requires_road_closure !== undefined ? data.requires_road_closure : ev.requires_road_closure,
          delay_mins: data.delay_mins !== undefined ? data.delay_mins : (ev.delay_mins || 0)
        });
      }
    } catch (e) {
      alert("Failed to fetch AI suggestion: " + e.message);
    }
  };

  const pendingReports = reports.filter(r => r.status === 'pending');
  const closedReports = reports.filter(r => r.status === 'verified' || r.status === 'rejected');

  return (
    <>
      <div className="drawer-header">
        <div className="drawer-title">
          <Shield size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
          Officer Panel
        </div>
        <button className="drawer-close" onClick={onClose}><X size={16} /></button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 24px' }}>
        {[['create', 'New Event'], ['events', `Active (${events.length})`], ['reports', `Reports (${pendingReports.length})`]].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)}
            style={{
              padding: '12px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: 'none', border: 'none', color: activeTab === key ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: activeTab === key ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'all 0.2s', fontFamily: 'Inter'
            }}>
            {label}
          </button>
        ))}
      </div>

      <div className="drawer-body" style={{ position: 'relative' }}>
        {loading && <LoadingSpinner message="Processing..." />}
        {/* Create Event Form */}
        {activeTab === 'create' && (
          <div>
            <div className="form-grid">
              <div className="full-width">
                <label className="label">Event Cause</label>
                <select className="input" value={form.event_cause} onChange={e => setForm({ ...form, event_cause: e.target.value })}>
                  {EVENT_CAUSES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase())}</option>)}
                </select>
              </div>
              <div className="full-width" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="label">Latitude</label>
                  <input className="input" type="number" step="any" value={form.latitude} onChange={e => setForm({ ...form, latitude: e.target.value })} placeholder="12.9716" />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="label">Longitude</label>
                  <input className="input" type="number" step="any" value={form.longitude} onChange={e => setForm({ ...form, longitude: e.target.value })} placeholder="77.5946" />
                </div>
                <div style={{ display: 'flex', gap: 4, paddingBottom: 2 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleUseGps} title="Use GPS Location" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <Compass size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleLocateClick} title="Locate on Map" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <MapPin size={14} />
                  </button>
                </div>
              </div>
              <div className="full-width">
                <label className="label">Address</label>
                <input className="input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="e.g. MG Road, Bengaluru" />
              </div>
              <div>
                <label className="label">Priority</label>
                <select className="input" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                  {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Corridor</label>
                <select className="input" value={form.corridor} onChange={e => setForm({ ...form, corridor: e.target.value })}>
                  {CORRIDORS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Clearance Time (mins)</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input" type="number" value={form.initial_clearance_time_mins} onChange={e => setForm({ ...form, initial_clearance_time_mins: e.target.value })} style={{ flex: 1 }} />
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    style={{ padding: 8, minWidth: 36, height: 36, borderRadius: 'var(--radius)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} 
                    onClick={handleCalculateClick}
                    title="Calculate Clearance Time"
                  >
                    <Calculator size={14} />
                  </button>
                </div>
              </div>
              <div>
                <label className="label">Vehicle Type</label>
                <input className="input" value={form.veh_type} onChange={e => setForm({ ...form, veh_type: e.target.value })} placeholder="e.g. truck, car" />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <button className={`toggle ${form.requires_road_closure ? 'active' : ''}`}
                    onClick={() => {
                      setForm({ ...form, requires_road_closure: !form.requires_road_closure });
                      setTempSuggestions(null);
                      if (onSetRouteData) onSetRouteData(null);
                      if (onSetDraftClosedRoute) onSetDraftClosedRoute(null);
                      if (onShowAiSuggestion) onShowAiSuggestion(null);
                    }} />
                  Road Closure
                </label>
              </div>
              {form.requires_road_closure && (
                <div className="full-width" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <label className="label">End Latitude</label>
                    <input className="input" type="number" step="any" value={form.endlatitude} onChange={e => setForm({ ...form, endlatitude: e.target.value })} placeholder="e.g. 12.9720" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="label">End Longitude</label>
                    <input className="input" type="number" step="any" value={form.endlongitude} onChange={e => setForm({ ...form, endlongitude: e.target.value })} placeholder="e.g. 77.5950" />
                  </div>
                  <div style={{ display: 'flex', gap: 4, paddingBottom: 2 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleUseGpsEnd} title="Use GPS Location" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                      <Compass size={14} />
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={handleLocateClickEnd} title="Locate on Map" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                      <MapPin size={14} />
                    </button>
                  </div>
                </div>
              )}
              <div className="full-width">
                <label className="label">Description</label>
                <textarea className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Incident details..." />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button 
                type="button"
                className="btn btn-primary" 
                style={{ flex: 2 }} 
                onClick={handleCreate} 
                disabled={loading}
              >
                {loading ? 'Creating...' : <><Plus size={14} /> Create Event</>}
              </button>
              <button 
                type="button" 
                className="btn" 
                style={{ 
                  flex: 2, 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: 6, 
                  background: !isServiceAllowed('ai_suggestion') ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, #8B5CF6 0%, #6366F1 100%)',
                  color: !isServiceAllowed('ai_suggestion') ? 'var(--text-muted)' : 'white',
                  border: 'none',
                  boxShadow: !isServiceAllowed('ai_suggestion') ? 'none' : '0 4px 12px rgba(139, 92, 246, 0.25)',
                  transition: 'all 0.2s ease',
                  opacity: (!form.event_cause || loading || !isServiceAllowed('ai_suggestion')) ? 0.5 : 1,
                  cursor: (!form.event_cause || loading || !isServiceAllowed('ai_suggestion')) ? 'not-allowed' : 'pointer'
                }}
                onClick={handleAiSuggestionClick} 
                disabled={!form.event_cause || loading || !isServiceAllowed('ai_suggestion')}
              >
                <Zap size={14} /> AI Suggestion
              </button>
              <button 
                type="button" 
                className="btn btn-ghost" 
                style={{ flex: 1, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} 
                onClick={handleClearForm} 
                title="Clear Form"
              >
                Clear
              </button>
            </div>
            {isServiceLimited('ai_suggestion') && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', marginTop: 8, padding: '0 4px' }}>
                <span>AI Suggestions remaining:</span>
                <span style={{ fontWeight: 600, color: (3 - (aiSuggestionAttempts || []).length) === 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {3 - (aiSuggestionAttempts || []).length} / 3 {aiSuggestionTimeLeft && `(Reset in ${aiSuggestionTimeLeft})`}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Active Events */}
        {activeTab === 'events' && (
          <div>
            {isServiceLimited('ai_suggestion') && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, padding: '0 4px', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <span>AI Suggestions remaining:</span>
                <span style={{ fontWeight: 600, color: (3 - (aiSuggestionAttempts || []).length) === 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {3 - (aiSuggestionAttempts || []).length} / 3 {aiSuggestionTimeLeft && `(Reset in ${aiSuggestionTimeLeft})`}
                </span>
              </div>
            )}
            {events.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No active events</p>
            ) : events.map(ev => (
              <div 
                key={ev.id} 
                id={`officer-event-card-${ev.id}`}
                className="event-card"
                style={selectedEventId === ev.id ? { outline: '2px solid #3b82f6', outlineOffset: '2px' } : {}}
              >
                <div className="event-card-header">
                  <span className="event-card-title">
                    {(ev.event_cause || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>({ev.id})</span>
                  </span>
                  <span className={`badge ${ev.zone_type === 'Red' ? 'badge-red' : 'badge-yellow'}`}>{ev.zone_type}</span>
                </div>
                <div className="event-card-meta">
                  <MapPin size={11} />{' '}
                  {(() => {
                    const latVal = ev.latitude !== undefined && ev.latitude !== null ? parseFloat(ev.latitude) : null;
                    const lngVal = ev.longitude !== undefined && ev.longitude !== null ? parseFloat(ev.longitude) : null;
                    const endLatVal = ev.endlatitude !== undefined && ev.endlatitude !== null && ev.endlatitude !== '' ? parseFloat(ev.endlatitude) : null;
                    const endLngVal = ev.endlongitude !== undefined && ev.endlongitude !== null && ev.endlongitude !== '' ? parseFloat(ev.endlongitude) : null;
                    
                    const startStr = latVal !== null && !isNaN(latVal) && lngVal !== null && !isNaN(lngVal) 
                      ? `${latVal.toFixed(6)}, ${lngVal.toFixed(6)}` 
                      : '';
                    const endStr = endLatVal !== null && !isNaN(endLatVal) && endLngVal !== null && !isNaN(endLngVal) 
                      ? `${endLatVal.toFixed(6)}, ${endLngVal.toFixed(6)}` 
                      : '';
                      
                    let coordsStr = '';
                    if (startStr && endStr) {
                      coordsStr = `S : [ ${startStr} ]  E : [ ${endStr} ]`;
                    } else if (startStr) {
                      coordsStr = `[ ${startStr} ]`;
                    }
                    
                    if (ev.address) {
                      return `${ev.address} ${coordsStr}`;
                    }
                    return coordsStr;
                  })()}
                </div>
                <div className="event-card-meta"><Clock size={11} /> {ev.current_clearance_time_mins} mins · <span className={`badge badge-sm ${ev.priority === 'High' ? 'badge-red' : ev.priority === 'Medium' ? 'badge-yellow' : 'badge-green'}`}>{ev.priority}</span></div>
                <div className="event-card-actions">
                  <button className="btn btn-success btn-sm" onClick={() => handleResolve(ev.id)}>
                    <CheckCircle size={12} /> Resolve
                  </button>
                  <button 
                    className="btn btn-primary btn-sm" 
                    onClick={() => isServiceAllowed('ai_suggestion') && handleShowSavedSuggestion(ev)}
                    disabled={!isServiceAllowed('ai_suggestion')}
                    style={{
                      opacity: isServiceAllowed('ai_suggestion') ? 1 : 0.4,
                      cursor: isServiceAllowed('ai_suggestion') ? 'pointer' : 'not-allowed'
                    }}
                  >
                    <Zap size={12} /> AI Suggestion
                  </button>
                  {snoozeId === ev.id ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input className="input" type="number" value={snoozeMins} onChange={e => setSnoozeMins(e.target.value)}
                        style={{ width: 60, padding: '4px 8px' }} />
                      <button className="btn btn-primary btn-sm" onClick={() => handleSnooze(ev.id)}>Set</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSnoozeId(null)}>✕</button>
                    </div>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => setSnoozeId(ev.id)}>
                      <Clock size={12} /> Snooze
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Reports Review */}
        {activeTab === 'reports' && (
          <div>
            {/* Reports Sub-tabs segment controller */}
            <div style={{
              display: 'flex',
              gap: 8,
              marginBottom: 16,
              background: 'rgba(0, 0, 0, 0.2)',
              padding: 4,
              borderRadius: 8,
              border: '1px solid var(--border)'
            }}>
              <button
                type="button"
                className={`btn btn-sm ${reportsSubTab === 'active' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ flex: 1, padding: '6px 12px', fontSize: 12, borderRadius: 6 }}
                onClick={() => setReportsSubTab('active')}
              >
                Active ({pendingReports.length})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${reportsSubTab === 'closed' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ flex: 1, padding: '6px 12px', fontSize: 12, borderRadius: 6 }}
                onClick={() => setReportsSubTab('closed')}
              >
                Closed ({closedReports.length})
              </button>
            </div>

            {reportsSubTab === 'active' ? (
              pendingReports.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No pending reports</p>
              ) : pendingReports.map(r => (
                <div key={r.id} className="event-card">
                  <div className="event-card-header">
                    <span className="event-card-title">{(r.event_cause || 'Report').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                    <span className="badge badge-blue">Pending</span>
                  </div>
                  <div className="event-card-meta"><MapPin size={11} /> {r.latitude?.toFixed(4)}, {r.longitude?.toFixed(4)}</div>
                  {r.description && <div className="event-card-meta" style={{ marginTop: 4 }}>{r.description}</div>}
                  <div className="event-card-actions">
                    {analyzingReportId === r.id ? (
                      <button className="btn btn-ghost btn-sm" disabled style={{ opacity: 0.7 }}>
                        Analyzing...
                      </button>
                    ) : (
                      <button 
                        className="btn btn-primary btn-sm" 
                        onClick={() => handleAnalyzeReport(r.id)}
                      >
                        <Zap size={12} /> Validate
                      </button>
                    )}
                    <button className="btn btn-danger btn-sm" onClick={() => handleReportStatus(r.id, 'rejected')}>
                      <XCircle size={12} /> Reject
                    </button>
                  </div>
                  {analysisResults[r.id] && (
                    <div className="report-analysis-box" style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>Confidence Score</span>
                        <span className="badge badge-sm" style={{ 
                          backgroundColor: analysisResults[r.id].confidence_score >= 75 ? 'var(--success)' : analysisResults[r.id].confidence_score >= 45 ? 'var(--warning)' : 'var(--danger)',
                          color: 'white'
                        }}>
                          {analysisResults[r.id].confidence_score.toFixed(0)}%
                        </span>
                      </div>
                      
                      <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 12, lineHeight: '1.4' }}>
                        {analysisResults[r.id].support_text}
                      </div>
                      
                      <button 
                        className="btn btn-success btn-sm" 
                        style={{ width: '100%' }} 
                        onClick={() => handleVerifyAndProceed(r.id)}
                      >
                        <CheckCircle size={12} /> Verify & Proceed
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              closedReports.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No closed reports</p>
              ) : closedReports.map(r => (
                <div key={r.id} className="event-card" style={{ opacity: 0.8 }}>
                  <div className="event-card-header">
                    <span className="event-card-title">{(r.event_cause || 'Report').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                    <span className={`badge ${r.status === 'verified' ? 'badge-green' : 'badge-red'}`}>
                      {r.status.replace(/^\w/, c => c.toUpperCase())}
                    </span>
                  </div>
                  <div className="event-card-meta"><MapPin size={11} /> {r.latitude?.toFixed(4)}, {r.longitude?.toFixed(4)}</div>
                  {r.description && <div className="event-card-meta" style={{ marginTop: 4 }}>{r.description}</div>}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, textAlign: 'right' }}>
                    Status: {r.status === 'verified' ? 'Approved & Escalated' : 'Dismissed'}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {showCalculatorDialog && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 16
        }}>
          <div style={{
            backgroundColor: '#1E293B',
            border: '1px solid #334155',
            borderRadius: 16,
            width: '100%',
            maxWidth: 400,
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
            overflow: 'hidden',
            fontFamily: 'Inter, sans-serif',
            position: 'relative'
          }}>
            {calculatingClearance && <LoadingSpinner message="Calculating clearance time..." />}
            {/* Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 20px',
              borderBottom: '1px solid #334155',
              background: 'linear-gradient(to right, #1E293B, #0F172A)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Clock size={16} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#F1F5F9' }}>Confirm Calculation Details</span>
              </div>
              <button 
                onClick={() => setShowCalculatorDialog(false)} 
                style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer' }}
              >
                <X size={16} />
              </button>
            </div>
            
            {/* Content */}
            <div style={{ padding: 20 }}>
              <p style={{ fontSize: 12, color: '#94A3B8', marginBottom: 16, lineHeight: 1.5 }}>
                Verify the event details below. You can only toggle <strong>Road Closure</strong> in this dialog. For other updates, close this dialog and edit the main form.
              </p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
                {/* Cause */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid #334155', paddingBottom: 8 }}>
                  <span style={{ color: '#94A3B8' }}>Event Cause</span>
                  <span style={{ color: '#F1F5F9', fontWeight: 500 }}>{(form.event_cause || 'others').replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase())}</span>
                </div>
                {/* Coordinates */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid #334155', paddingBottom: 8 }}>
                  <span style={{ color: '#94A3B8' }}>Coordinates</span>
                  <span style={{ color: '#F1F5F9', fontWeight: 500 }}>{form.latitude ? parseFloat(form.latitude).toFixed(4) : ''}, {form.longitude ? parseFloat(form.longitude).toFixed(4) : ''}</span>
                </div>
                {/* Vehicle Type */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid #334155', paddingBottom: 8 }}>
                  <span style={{ color: '#94A3B8' }}>Vehicle Type</span>
                  <span style={{ color: '#F1F5F9', fontWeight: 500 }}>{form.veh_type || 'unknown'}</span>
                </div>
                {/* Corridor */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid #334155', paddingBottom: 8 }}>
                  <span style={{ color: '#94A3B8' }}>Corridor</span>
                  <span style={{ color: '#F1F5F9', fontWeight: 500 }}>{form.corridor || 'Non-corridor'}</span>
                </div>
                {/* Road Closure Toggle (Editable) */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, paddingTop: 4 }}>
                  <span style={{ color: '#94A3B8', fontWeight: 600 }}>Requires Road Closure</span>
                  <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <button 
                      className={`toggle ${form.requires_road_closure ? 'active' : ''}`}
                      onClick={() => {
                        setForm(prev => ({ ...prev, requires_road_closure: !prev.requires_road_closure }));
                        setTempSuggestions(null);
                        if (onSetRouteData) onSetRouteData(null);
                        if (onSetDraftClosedRoute) onSetDraftClosedRoute(null);
                        if (onShowAiSuggestion) onShowAiSuggestion(null);
                      }} 
                      style={{ marginRight: 0 }}
                    />
                  </label>
                </div>
              </div>
            </div>
            
            {/* Actions */}
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 10,
              padding: '12px 20px',
              backgroundColor: '#0F172A',
              borderTop: '1px solid #334155'
            }}>
              <button 
                type="button" 
                className="btn btn-ghost" 
                onClick={() => setShowCalculatorDialog(false)}
                style={{ color: '#94A3B8' }}
              >
                Cancel
              </button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={handleConfirmCalculation}
                disabled={calculatingClearance}
                style={{
                  background: 'linear-gradient(to right, #3B82F6, #1D4ED8)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
              >
                {calculatingClearance ? 'Calculating...' : 'Confirm & Calculate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLocationSelector && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1100,
          padding: '16px'
        }}>
          {loading && <LoadingSpinner message="Generating AI suggestion..." />}
          <div style={{
            backgroundColor: '#1E293B',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '520px',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
            overflow: 'hidden',
            fontFamily: 'Inter, sans-serif'
          }}>
            {/* Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 20px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              background: 'linear-gradient(to right, #1E293B, #0F172A)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Zap size={16} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: '15px', fontWeight: 700, color: '#F1F5F9' }}>
                  AI Suggestion: Location Scope
                </span>
              </div>
              <button 
                onClick={() => setShowLocationSelector(false)} 
                style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', display: 'flex', padding: 4 }}
              >
                <X size={18} />
              </button>
            </div>
            
            {/* Body */}
            <div style={{ padding: '20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ fontSize: '12px', color: '#94A3B8', margin: 0, lineHeight: 1.5 }}>
                Enter the incident locations or select them on the map to visualize and compile AI recommendations.
              </p>
              
              {/* Start location */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', fontWeight: 700, color: '#E2E8F0', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <MapPin size={12} color="#22c55e" /> START LOCATION
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <input 
                      type="text" 
                      className="input" 
                      value={startLocName} 
                      onChange={(e) => setStartLocName(e.target.value)} 
                      onKeyDown={(e) => e.key === 'Enter' && handleStartSearch()}
                      placeholder="Location name or Lat, Lng"
                      style={{ width: '100%', paddingRight: '36px' }}
                    />
                    {isGeocodingStart && (
                      <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex' }}>
                        <div className="spinner-loader" style={{ width: 14, height: 14 }} />
                      </div>
                    )}
                  </div>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={handleStartSearch} 
                    title="Search Address"
                    style={{ padding: '8px', minWidth: '36px', height: '36px', border: '1px solid var(--border)' }}
                  >
                    <Search size={14} />
                  </button>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={() => {
                      if (userLocation) {
                        setRouteStartLat(userLocation.lat.toFixed(6));
                        setRouteStartLng(userLocation.lng.toFixed(6));
                      } else {
                        navigator.geolocation.getCurrentPosition(
                          pos => {
                            setRouteStartLat(pos.coords.latitude.toFixed(6));
                            setRouteStartLng(pos.coords.longitude.toFixed(6));
                          },
                          () => alert('Could not get GPS location.')
                        );
                      }
                    }} 
                    title="Get Current GPS"
                    style={{ padding: '8px', minWidth: '36px', height: '36px', border: '1px solid var(--border)' }}
                  >
                    <Compass size={14} />
                  </button>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={() => {
                      setActivePlacementMode(activePlacementMode === 'start' ? null : 'start');
                    }} 
                    title="Select Start Location on map preview below"
                    style={{ 
                      padding: '8px', 
                      minWidth: '36px', 
                      height: '36px', 
                      border: activePlacementMode === 'start' ? '1px solid #22c55e' : '1px solid rgba(255,255,255,0.08)',
                      background: activePlacementMode === 'start' ? 'rgba(34, 197, 94, 0.1)' : 'none',
                      color: '#22c55e',
                      boxShadow: activePlacementMode === 'start' ? '0 0 10px rgba(34, 197, 94, 0.2)' : 'none',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <MapPin size={14} color="#22c55e" />
                  </button>
                </div>
                {activePlacementMode === 'start' && (
                  <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600, marginTop: '4px' }}>
                    * Right-click on the map preview below to place the Start location.
                  </div>
                )}
                <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--accent-light)' }}>
                  Lat: {routeStartLat || 'Not set'}, Lng: {routeStartLng || 'Not set'}
                </div>
              </div>

              {/* End location */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', fontWeight: 700, color: '#E2E8F0', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <MapPin size={12} color="#ef4444" /> END LOCATION
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ position: 'relative', flex: 1 }}>
                    <input 
                      type="text" 
                      className="input" 
                      value={endLocName} 
                      onChange={(e) => setEndLocName(e.target.value)} 
                      onKeyDown={(e) => e.key === 'Enter' && handleEndSearch()}
                      placeholder="Location name or Lat, Lng"
                      style={{ width: '100%', paddingRight: '36px' }}
                    />
                    {isGeocodingEnd && (
                      <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex' }}>
                        <div className="spinner-loader" style={{ width: 14, height: 14 }} />
                      </div>
                    )}
                  </div>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={handleEndSearch} 
                    title="Search Address"
                    style={{ padding: '8px', minWidth: '36px', height: '36px', border: '1px solid var(--border)' }}
                  >
                    <Search size={14} />
                  </button>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={() => {
                      if (userLocation) {
                        setRouteEndLat(userLocation.lat.toFixed(6));
                        setRouteEndLng(userLocation.lng.toFixed(6));
                      } else {
                        navigator.geolocation.getCurrentPosition(
                          pos => {
                            setRouteEndLat(pos.coords.latitude.toFixed(6));
                            setRouteEndLng(pos.coords.longitude.toFixed(6));
                          },
                          () => alert('Could not get GPS location.')
                        );
                      }
                    }} 
                    title="Get Current GPS"
                    style={{ padding: '8px', minWidth: '36px', height: '36px', border: '1px solid var(--border)' }}
                  >
                    <Compass size={14} />
                  </button>
                  <button 
                    type="button" 
                    className="btn btn-ghost" 
                    onClick={() => {
                      setActivePlacementMode(activePlacementMode === 'end' ? null : 'end');
                    }} 
                    title="Select End Location on map preview below"
                    style={{ 
                      padding: '8px', 
                      minWidth: '36px', 
                      height: '36px', 
                      border: activePlacementMode === 'end' ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.08)',
                      background: activePlacementMode === 'end' ? 'rgba(239, 68, 68, 0.1)' : 'none',
                      color: '#ef4444',
                      boxShadow: activePlacementMode === 'end' ? '0 0 10px rgba(239, 68, 68, 0.2)' : 'none',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <MapPin size={14} color="#ef4444" />
                  </button>
                </div>
                {activePlacementMode === 'end' && (
                  <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600, marginTop: '4px' }}>
                    * Right-click on the map preview below to place the End location.
                  </div>
                )}
                <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--accent-light)' }}>
                  Lat: {routeEndLat || 'Not set'}, Lng: {routeEndLng || 'Not set'}
                </div>
              </div>

              {/* Minimap preview */}
              {form.latitude && form.longitude && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Incident Scope Preview
                  </span>
                  <MiniMap 
                    key={`selector-map-${routeStartLat || ''}-${routeStartLng || ''}-${routeEndLat || ''}-${routeEndLng || ''}-${form.requires_road_closure}`}
                    lat={routeStartLat ? parseFloat(routeStartLat) : null} 
                    lng={routeStartLng ? parseFloat(routeStartLng) : null} 
                    endLat={routeEndLat ? parseFloat(routeEndLat) : null}
                    endLng={routeEndLng ? parseFloat(routeEndLng) : null}
                    roadStartLat={form.latitude ? parseFloat(form.latitude) : null}
                    roadStartLng={form.longitude ? parseFloat(form.longitude) : null}
                    roadEndLat={form.endlatitude ? parseFloat(form.endlatitude) : null}
                    roadEndLng={form.endlongitude ? parseFloat(form.endlongitude) : null}
                    routeData={selectorClosedRoute ? { closed_route: { geometry: selectorClosedRoute } } : null}
                    events={events}
                    zoneType={form.requires_road_closure ? 'Red' : 'Yellow'}
                    onMapClick={handleDialogMapClick}
                  />
                </div>
              )}
            </div>
            
            {/* Footer */}
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              padding: '12px 20px',
              backgroundColor: '#0F172A',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <button 
                type="button" 
                className="btn btn-ghost" 
                onClick={() => setShowLocationSelector(false)}
                disabled={loading}
                style={{ color: '#94A3B8' }}
              >
                Cancel
              </button>
              <button 
                type="button" 
                className="btn btn-primary" 
                onClick={executeGenerateAiSuggestion}
                disabled={loading || !form.latitude || !form.longitude || (form.requires_road_closure && (!form.endlatitude || !form.endlongitude))}
                style={{
                  background: 'linear-gradient(135deg, #8B5CF6 0%, #6366F1 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
              >
                <Zap size={14} /> Confirm & Generate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
