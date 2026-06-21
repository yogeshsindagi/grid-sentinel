import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, LogOut, Navigation, AlertTriangle, List, BarChart3, MessageCircle, Settings, X, Send, Crosshair, Layers, MapPin, Clock, ChevronRight, CheckCircle, XCircle, Zap, Users, Eye, EyeOff, Search, Compass, Info, Menu, LayoutDashboard, Calendar } from 'lucide-react';
import MapDashboard from './components/MapDashboard';
import LoadingSpinner from './components/LoadingSpinner';
import OfficerPanel from './components/OfficerPanel';
import TravelerPanel from './components/TravelerPanel';
import AdminPanel from './components/AdminPanel';
import MiniMap from './components/MiniMap';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import HistoricalAnalyticsDashboard from './components/HistoricalAnalyticsDashboard';
import { api } from './utils/api';
import './App.css';

const GOOGLE_CLIENT_ID = '998246206124-llsrb5n1tigjivrd7g0or7r2e6ecit4m.apps.googleusercontent.com';

const BENGALURU_AREAS = {
  'indiranagar': [77.6406, 12.9719],
  'koramangala': [77.6245, 12.9348],
  'whitefield': [77.7499, 12.9698],
  'mg road': [77.6068, 12.9738],
  'electronic city': [77.6657, 12.8487],
  'jayanagar': [77.5824, 12.9299],
  'jp nagar': [77.5888, 12.9063],
  'hebbal': [77.5913, 13.0359],
  'hsr layout': [77.6413, 12.9103],
  'malleshwaram': [77.5704, 12.9984],
  'yeshwanthpur': [77.5505, 13.0238],
  'banashankari': [77.5541, 12.9255],
  'marathahalli': [77.7007, 12.9562],
  'btm layout': [77.6094, 12.9166],
  'rajajinagar': [77.5562, 12.9896],
  'rt nagar': [77.5937, 13.0182],
  'yelahanka': [77.5963, 13.1007],
  'kalyan nagar': [77.6475, 13.0242],
  'bellandur': [77.6749, 12.9304]
};

const geocodeArea = async (query) => {
  const q = query.toLowerCase().trim();
  
  const coordRegex = /^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/;
  const match = q.match(coordRegex);
  if (match) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }

  for (const [key, coords] of Object.entries(BENGALURU_AREAS)) {
    if (q.includes(key) || key.includes(q)) {
      return { lng: coords[0], lat: coords[1] };
    }
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ', Bengaluru')}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'GridLock-Sentinel' } });
    const data = await res.json();
    if (data && data.length > 0) {
      return { lng: parseFloat(data[0].lon), lat: parseFloat(data[0].lat) };
    }
  } catch (e) {
    console.error('OSM Geocode error:', e);
  }
  return null;
};

function renderMarkdown(text) {
  if (!text) return null;
  // Sanitizer for mismatched bold markers (e.g., *Cause/Type:** -> **Cause/Type:**)
  const sanitizedText = text
    .replace(/\*([^*\n]+?):\*\*/g, '**$1:**')
    .replace(/\*\*([^*\n]+?):\*/g, '**$1:**')
    .replace(/\*([^*\n]+?)\*\*/g, '**$1**')
    .replace(/\*\*([^*\n]+?)\*/g, '**$1**')
    .replace(/\*([^*\n]+?):\*/g, '**$1:**');

  const lines = sanitizedText.split('\n');
  const elements = [];
  let inList = false;
  let listItems = [];
  let inTable = false;
  let tableRows = [];

  const parseInline = (str) => {
    let html = str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Parse markdown links [label](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');

    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  };

  const renderTable = (rows, tableKey) => {
    let headers = [];
    const bodyRows = [];
    
    rows.forEach((row, rIdx) => {
      const cells = row.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
      const isSeparator = cells.every(c => /^[:\s-]*$/.test(c));
      if (isSeparator) return;
      
      if (headers.length === 0 && rIdx === 0) {
        headers = cells;
      } else {
        bodyRows.push(cells);
      }
    });
    
    if (headers.length === 0 && bodyRows.length > 0) {
      headers = bodyRows.shift();
    }
    
    return (
      <div key={tableKey} className="chat-table-container">
        <table className="chat-table">
          <thead>
            <tr>
              {headers.map((h, hIdx) => (
                <th key={`th-${hIdx}`}>{parseInline(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((rowCells, rowIdx) => (
              <tr key={`tr-${rowIdx}`}>
                {Array.from({ length: headers.length }).map((_, cellIdx) => (
                  <td key={`td-${cellIdx}`}>{parseInline(rowCells[cellIdx] || '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const flushList = (index) => {
    if (inList && listItems.length > 0) {
      elements.push(<ul key={`list-${index}`} className="chat-list">{listItems}</ul>);
      listItems = [];
      inList = false;
    }
  };

  const flushTable = (index) => {
    if (inTable && tableRows.length > 0) {
      elements.push(renderTable(tableRows, `table-${index}`));
      tableRows = [];
      inTable = false;
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList(index);
      flushTable(index);
      return;
    }

    const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1;

    if (isTableRow) {
      flushList(index);
      if (!inTable) {
        inTable = true;
      }
      tableRows.push(trimmed);
    } else {
      flushTable(index);

      const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
      const listMatch = trimmed.match(/^[-*•]\s*(.*)/);
      const hrMatch = trimmed.match(/^[-*_]{2,}\s*$/);

      if (headerMatch) {
        flushList(index);
        const level = headerMatch[1].length;
        const Tag = `h${level}`;
        elements.push(<Tag key={`h-${index}`} className={`chat-h${level}`}>{parseInline(headerMatch[2])}</Tag>);
      } else if (hrMatch) {
        flushList(index);
        elements.push(<hr key={`hr-${index}`} className="chat-hr" />);
      } else if (listMatch) {
        if (!inList) {
          inList = true;
        }
        listItems.push(<li key={`li-${index}`}>{parseInline(listMatch[1])}</li>);
      } else {
        flushList(index);
        elements.push(<p key={`p-${index}`} className="chat-para">{parseInline(trimmed)}</p>);
      }
    }
  });

  flushList('end');
  flushTable('end');

  return <div className="chat-markdown">{elements}</div>;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(api.getUser());
  const [hash, setHash] = useState(window.location.hash);
  const [events, setEvents] = useState([]);
  const [reports, setReports] = useState([]);
  const [activeDrawer, setActiveDrawer] = useState(null);
  const [showAiSuggestionModal, setShowAiSuggestionModal] = useState(false);
  const [aiSuggestionData, setAiSuggestionData] = useState(null);
  const [aiSuggestionLoading, setAiSuggestionLoading] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [routeData, setRouteData] = useState(null);
  const [draftClosedRoute, setDraftClosedRoute] = useState(null);
  const [mapClickCoords, setMapClickCoords] = useState(null);
  const [mapEventStartCoords, setMapEventStartCoords] = useState(null);
  const [mapEventEndCoords, setMapEventEndCoords] = useState(null);
  const [showReportForm, setShowReportForm] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHowToUseModal, setShowHowToUseModal] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [routeSource, setRouteSource] = useState('');
  const [routeDest, setRouteDest] = useState('');
  const [routeLoading, setRouteLoading] = useState(false);
  const [showRoutebar, setShowRoutebar] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [selectedDemoRole, setSelectedDemoRole] = useState(null);
  const [demoLoginLoading, setDemoLoginLoading] = useState(false);

  const handleDemoLogin = async (role) => {
    if (!role) return;
    setDemoLoginLoading(true);
    try {
      const data = await api.demoLogin(role);
      api.setToken(data.token);
      api.setUser(data.user);
      setCurrentUser(data.user);
    } catch (err) {
      setLoginError(err.message || 'Demo login failed');
    } finally {
      setDemoLoginLoading(false);
    }
  };

  const [settings, setSettings] = useState({});
  const [showDensitySearch, setShowDensitySearch] = useState(false);
  const [densityQuery, setDensityQuery] = useState('');
  const [densityLoading, setDensityLoading] = useState(false);
  const [densityAttempts, setDensityAttempts] = useState(() => {
    try {
      const stored = localStorage.getItem('gridlock_density_attempts');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  });
  const [densityTimeLeft, setDensityTimeLeft] = useState(null);
  const [routeAttempts, setRouteAttempts] = useState(() => {
    try {
      const stored = localStorage.getItem('gridlock_route_attempts');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  });
  const [routeTimeLeft, setRouteTimeLeft] = useState(null);
  const [chatAttempts, setChatAttempts] = useState(() => {
    try {
      const stored = localStorage.getItem('gridlock_chat_attempts');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  });
  const [chatTimeLeft, setChatTimeLeft] = useState(null);
  const [aiSuggestionAttempts, setAiSuggestionAttempts] = useState(() => {
    try {
      const stored = localStorage.getItem('gridlock_ai_suggestion_attempts');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  });
  const [aiSuggestionTimeLeft, setAiSuggestionTimeLeft] = useState(null);

  const [mapSelectMode, setMapSelectMode] = useState(null);
  const mapRef = useRef(null);

  const isServiceAllowed = (serviceKey) => {
    if (serviceKey === 'verification') return true;
    if (!currentUser) return false;
    if (currentUser.role === 'Admin') return true;

    const modeAll = settings[`${serviceKey}_mode_all`] !== false;
    const modeCustom = settings[`${serviceKey}_mode_custom`] === true;

    if (modeCustom) {
      const val = settings[`${serviceKey}_roles_${currentUser.role}`];
      return val === 'on' || val === 'limited' || val === true || val === 'true' || val === undefined;
    }
    return modeAll;
  };

  const isServiceLimited = (serviceKey) => {
    if (serviceKey === 'verification') return false;
    if (!currentUser) return false;
    if (currentUser.role === 'Admin') return false;

    const modeCustom = settings[`${serviceKey}_mode_custom`] === true;
    if (modeCustom) {
      const val = settings[`${serviceKey}_roles_${currentUser.role}`];
      return val === 'limited';
    }
    return false;
  };

  const handleShowActiveEventSuggestions = async (ev) => {
    if (!isServiceAllowed('ai_suggestion')) {
      alert("AI Suggestions has been disabled by the system administrator.");
      return;
    }

    let validAttempts = [...aiSuggestionAttempts];
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;

    if (isServiceLimited('ai_suggestion')) {
      const filtered = aiSuggestionAttempts.filter(t => now - t < windowMs);
      if (filtered.length >= 3) {
        alert("AI Suggestions limit reached. You can request 3 recommendations per 10-minute window.");
        return;
      }
      validAttempts = filtered;
    }

    setAiSuggestionLoading(true);
    try {
      const data = await api.getEventSuggestions(ev.id);
      setAiSuggestionData({
        ...data,
        event_cause: ev.event_cause,
        address: ev.address,
        priority: ev.priority,
        zone_type: ev.zone_type || data.zone_type,
        routeData: data.routeData || (data.detour_route_geojson ? JSON.parse(data.detour_route_geojson) : null)
      });
      setShowAiSuggestionModal(true);

      if (isServiceLimited('ai_suggestion')) {
        const newAttempts = [...validAttempts, now];
        setAiSuggestionAttempts(newAttempts);
        localStorage.setItem('gridlock_ai_suggestion_attempts', JSON.stringify(newAttempts));
      }
    } catch (e) {
      alert("Failed to load AI suggestions: " + e.message);
    } finally {
      setAiSuggestionLoading(false);
    }
  };

  // Hash routing
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Monitor resize for mobile/desktop map guide responsive rendering
  useEffect(() => {
    const handleResize = () => setIsMobileView(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Clear route planner inputs and data when closed (ignoring temporary map selection hides)
  useEffect(() => {
    if (!showRoutebar && mapSelectMode !== 'route_start' && mapSelectMode !== 'route_end') {
      setRouteSource('');
      setRouteDest('');
      setRouteData(null);
    }
  }, [showRoutebar, mapSelectMode]);

  // Scroll to active event card for commuter
  useEffect(() => {
    if (selectedEventId && activeDrawer === 'events') {
      const timer = setTimeout(() => {
        const element = document.getElementById(`commuter-event-card-${selectedEventId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [selectedEventId, activeDrawer]);

  // Clear selected event selection when active drawer changes to null
  useEffect(() => {
    if (!activeDrawer) {
      setSelectedEventId(null);
    }
  }, [activeDrawer]);

  const handleEventClick = (ev) => {
    if (!ev || !ev.id) return;
    setSelectedEventId(ev.id);
    const isOfficer = ['Officer', 'Admin'].includes(currentUser?.role);
    if (isOfficer) {
      setActiveDrawer('officer');
    } else {
      setActiveDrawer('events');
    }
  };

  const isAdminPortal = hash === '#/admin-portal';

  // Load Google Identity Services
  useEffect(() => {
    if (currentUser || isAdminPortal) return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleGoogleCallback,
          ux_mode: 'popup'
        });
        const btn = document.getElementById('google-signin-btn');
        if (btn) {
          window.google.accounts.id.renderButton(btn, {
            type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', width: 300, text: 'continue_with'
          });
        }
      }
    };
    document.body.appendChild(script);
    return () => { try { document.body.removeChild(script); } catch(e) {} };
  }, [currentUser, isAdminPortal]);

  const handleGoogleCallback = async (response) => {
    try {
      setLoginError('');
      const data = await api.googleLogin(response.credential);
      api.setToken(data.token);
      api.setUser(data.user);
      setCurrentUser(data.user);
    } catch (err) {
      setLoginError(err.message || 'Login failed');
    }
  };

  // Fetch events periodically
  useEffect(() => {
    if (!currentUser || isAdminPortal) return;
    const fetchEvents = async () => {
      try { const ev = await api.getEvents('active'); setEvents(ev); } catch (e) {}
    };
    fetchEvents();
    const interval = setInterval(fetchEvents, 15000);
    return () => clearInterval(interval);
  }, [currentUser, isAdminPortal]);

  // Fetch reports for officers
  useEffect(() => {
    if (!currentUser || !['Officer', 'Admin'].includes(currentUser.role)) return;
    const fetchReports = async () => {
      try { const rp = await api.getReports(); setReports(rp); } catch (e) {}
    };
    fetchReports();
  }, [currentUser, activeDrawer]);

  // Live GPS tracking on mount
  useEffect(() => {
    if (!currentUser) return;
    let watchId;
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => console.warn("Live GPS Watch warning:", err),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
      );
    }
    return () => { if (watchId) navigator.geolocation.clearWatch(watchId); };
  }, [currentUser]);

  // Fetch settings periodically
  useEffect(() => {
    if (!currentUser || isAdminPortal) return;
    const fetchSettings = async () => {
      try {
        const s = await api.getSettings();
        setSettings(s);
      } catch (e) {}
    };
    fetchSettings();
    const interval = setInterval(fetchSettings, 30000);
    return () => clearInterval(interval);
  }, [currentUser, isAdminPortal]);

  // Sync rate limit countdown timer
  useEffect(() => {
    if (densityAttempts.length === 0) {
      setDensityTimeLeft(null);
      return;
    }
    
    const interval = setInterval(() => {
      const firstAttempt = densityAttempts[0];
      const now = Date.now();
      const elapsed = now - firstAttempt;
      const windowMs = 10 * 60 * 1000;
      
      if (elapsed >= windowMs) {
        setDensityAttempts([]);
        localStorage.removeItem('gridlock_density_attempts');
        setDensityTimeLeft(null);
        clearInterval(interval);
      } else {
        const remaining = windowMs - elapsed;
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setDensityTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [densityAttempts]);

  // 10-minute auto refresh for searched density location
  useEffect(() => {
    if (!showDensitySearch || !mapRef.current) return;
    
    const interval = setInterval(async () => {
      if (isServiceAllowed('density')) {
        console.log("Auto-refreshing traffic density for searched viewport...");
        if (mapRef.current) {
          await mapRef.current.triggerTrafficFetch();
        }
      }
    }, 10 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, [showDensitySearch, settings, currentUser]);

  // Sync Route Planner rate limit countdown timer
  useEffect(() => {
    if (routeAttempts.length === 0) {
      setRouteTimeLeft(null);
      return;
    }
    
    const interval = setInterval(() => {
      const firstAttempt = routeAttempts[0];
      const now = Date.now();
      const elapsed = now - firstAttempt;
      const windowMs = 10 * 60 * 1000;
      
      if (elapsed >= windowMs) {
        setRouteAttempts([]);
        localStorage.removeItem('gridlock_route_attempts');
        setRouteTimeLeft(null);
        clearInterval(interval);
      } else {
        const remaining = windowMs - elapsed;
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setRouteTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [routeAttempts]);

  // Sync Chatbot rate limit countdown timer
  useEffect(() => {
    if (chatAttempts.length === 0) {
      setChatTimeLeft(null);
      return;
    }
    
    const interval = setInterval(() => {
      const firstAttempt = chatAttempts[0];
      const now = Date.now();
      const elapsed = now - firstAttempt;
      const windowMs = 10 * 60 * 1000;
      
      if (elapsed >= windowMs) {
        setChatAttempts([]);
        localStorage.removeItem('gridlock_chat_attempts');
        setChatTimeLeft(null);
        clearInterval(interval);
      } else {
        const remaining = windowMs - elapsed;
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setChatTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [chatAttempts]);

  // Sync AI Suggestions rate limit countdown timer
  useEffect(() => {
    if (aiSuggestionAttempts.length === 0) {
      setAiSuggestionTimeLeft(null);
      return;
    }
    
    const interval = setInterval(() => {
      const firstAttempt = aiSuggestionAttempts[0];
      const now = Date.now();
      const elapsed = now - firstAttempt;
      const windowMs = 10 * 60 * 1000;
      
      if (elapsed >= windowMs) {
        setAiSuggestionAttempts([]);
        localStorage.removeItem('gridlock_ai_suggestion_attempts');
        setAiSuggestionTimeLeft(null);
        clearInterval(interval);
      } else {
        const remaining = windowMs - elapsed;
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setAiSuggestionTimeLeft(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);

  }, [aiSuggestionAttempts]);

  const handleRecordAttempt = (serviceKey, newAttempts) => {
    localStorage.setItem(`gridlock_${serviceKey}_attempts`, JSON.stringify(newAttempts));
    if (serviceKey === 'ai_suggestion') {
      setAiSuggestionAttempts(newAttempts);
    }
  };

  const handleSignOut = () => { api.clearToken(); setCurrentUser(null); setActiveDrawer(null); setRouteData(null); };

  const handleLocateMe = () => {
    if (userLocation) {
      if (mapRef.current) mapRef.current.flyTo(userLocation);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserLocation(loc);
          if (mapRef.current) mapRef.current.flyTo(loc);
        },
        () => alert('Could not get your location. Please check location permissions.'),
        { enableHighAccuracy: true }
      );
    }
  };

  const handleMapRightClick = (coords) => {
    if (mapSelectMode) {
      handleMapClick(coords);
    } else {
      setMapClickCoords(coords);
      setShowReportForm(true);
      setActiveDrawer(null);
      setShowRoutebar(false);
      setShowDensitySearch(false);
      setDensityQuery('');
      if (mapRef.current) mapRef.current.clearTraffic();
    }
  };

  const handleStartMapSelect = (mode) => {
    setMapSelectMode(mode);
    if (mode === 'route_start' || mode === 'route_end') {
      setShowRoutebar(false);
    }
  };

  const handleMapClick = (coords) => {
    if (mapSelectMode) {
      const latLngStr = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
      if (mapSelectMode === 'report') {
        setMapClickCoords(coords);
        setShowReportForm(true);
        setTimeout(() => setMapClickCoords(null), 1000); // Clear marker after 1 second
      } else if (mapSelectMode === 'create_event') {
        setMapEventStartCoords(coords);
        setActiveDrawer('officer');
      } else if (mapSelectMode === 'create_event_end') {
        setMapEventEndCoords(coords);
        setActiveDrawer('officer');
      } else if (mapSelectMode === 'route_start') {
        setRouteSource(latLngStr);
        if (isServiceAllowed('routing')) setShowRoutebar(true);
      } else if (mapSelectMode === 'route_end') {
        setRouteDest(latLngStr);
        if (isServiceAllowed('routing')) setShowRoutebar(true);
      } else if (mapSelectMode === 'density_select') {
        setDensityQuery(latLngStr);
        if (isServiceAllowed('density')) setShowDensitySearch(true);
      }
      setMapSelectMode(null);
    }
  };

  const handleRouteSourceGps = () => {
    if (userLocation) {
      setRouteSource(`${userLocation.lat.toFixed(6)}, ${userLocation.lng.toFixed(6)}`);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserLocation(loc);
          setRouteSource(`${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`);
        },
        () => alert('Could not get your location. Please check location permissions.'),
        { enableHighAccuracy: true }
      );
    } else {
      alert("GPS location is not available.");
    }
  };

  const handleRouteDestGps = () => {
    if (userLocation) {
      setRouteDest(`${userLocation.lat.toFixed(6)}, ${userLocation.lng.toFixed(6)}`);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserLocation(loc);
          setRouteDest(`${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`);
        },
        () => alert('Could not get your location. Please check location permissions.'),
        { enableHighAccuracy: true }
      );
    } else {
      alert("GPS location is not available.");
    }
  };

  const handleDensityGps = () => {
    if (userLocation) {
      setDensityQuery(`${userLocation.lat.toFixed(6)}, ${userLocation.lng.toFixed(6)}`);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserLocation(loc);
          setDensityQuery(`${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`);
        },
        () => alert('Could not get your location. Please check location permissions.'),
        { enableHighAccuracy: true }
      );
    } else {
      alert("GPS location is not available.");
    }
  };

  const handleLocateOnMap = (lat, lng, setMarker = true) => {
    const l = parseFloat(lat);
    const n = parseFloat(lng);
    if (!isNaN(l) && !isNaN(n)) {
      if (mapRef.current?.flyTo) {
        mapRef.current.flyTo({ lat: l, lng: n });
      }
      if (setMarker) {
        setMapClickCoords({ lat: l, lng: n });
      }
    } else {
      alert("Please enter valid numeric coordinates first.");
    }
  };

  const handleFindRoute = async () => {
    if (!isServiceAllowed('routing')) {
      alert("Route planning service is disabled by the administrator.");
      return;
    }
    if (!routeSource || !routeDest) return;

    // Check rate limits conditionally
    let validAttempts = [...routeAttempts];
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;

    if (isServiceLimited('routing')) {
      const filtered = routeAttempts.filter(t => now - t < windowMs);
      if (filtered.length >= 3) {
        alert("Route planning limit reached. You can perform 3 calculations per 10-minute window.");
        return;
      }
      validAttempts = filtered;
    }

    setRouteLoading(true);
    try {
      const parseCoord = (s) => {
        const parts = s.split(',').map(x => parseFloat(x.trim()));
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return { lat: parts[0], lng: parts[1] };
        return null;
      };
      const srcCoord = parseCoord(routeSource);
      const dstCoord = parseCoord(routeDest);
      const start_lat = srcCoord ? srcCoord.lat : routeSource;
      const start_lon = srcCoord ? srcCoord.lng : null;
      const end_lat = dstCoord ? dstCoord.lat : routeDest;
      const end_lon = dstCoord ? dstCoord.lng : null;
      const data = await api.getRoute(start_lat, start_lon, end_lat, end_lon);
      setRouteData(data);

      if (isServiceLimited('routing')) {
        const newAttempts = [...validAttempts, now];
        setRouteAttempts(newAttempts);
        localStorage.setItem('gridlock_route_attempts', JSON.stringify(newAttempts));
      }
    } catch (e) {
      alert('Route calculation failed: ' + e.message);
    } finally {
      setRouteLoading(false);
    }
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;

    if (!isServiceAllowed('chatbot')) {
      alert("This service has been disabled by the system administrator.");
      return;
    }

    let validAttempts = [...chatAttempts];
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;

    if (isServiceLimited('chatbot')) {
      const filtered = chatAttempts.filter(t => now - t < windowMs);
      if (filtered.length >= 3) {
        alert("Chatbot message limit reached. You can send 3 messages per 10-minute window.");
        return;
      }
      validAttempts = filtered;
    }

    const msg = chatInput.trim();
    setChatMessages(prev => [...prev, { role: 'user', text: msg }]);
    setChatInput('');
    setChatLoading(true);
    try {
      const res = await api.chat(msg);
      setChatMessages(prev => [...prev, { role: 'bot', text: res.reply }]);

      if (isServiceLimited('chatbot')) {
        const newAttempts = [...validAttempts, now];
        setChatAttempts(newAttempts);
        localStorage.setItem('gridlock_chat_attempts', JSON.stringify(newAttempts));
      }
    } catch (e) {
      setChatMessages(prev => [...prev, { role: 'bot', text: 'Sorry, I encountered an error. Please try again.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  const toggleDrawer = (name) => {
    if (name === 'chat' && !isServiceAllowed('chatbot')) {
      return;
    }
    setActiveDrawer(prev => {
      const next = prev === name ? null : name;
      if (next) {
        setShowRoutebar(false);
        setShowDensitySearch(false);
        setDensityQuery('');
        if (mapRef.current) mapRef.current.clearTraffic();
        setShowReportForm(false);
        setMapClickCoords(null);
      }
      return next;
    });
  };

  const handleDensitySearch = async () => {
    if (!densityQuery.trim()) return;
    
    // Check Admin disablers
    if (!isServiceAllowed('density')) {
      alert("This service has been disabled by the system administrator.");
      return;
    }

    let validAttempts = [...densityAttempts];
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;

    if (isServiceLimited('density')) {
      const filtered = densityAttempts.filter(t => now - t < windowMs);
      if (filtered.length >= 3) {
        alert("Search limit reached. You can perform 3 searches per 10-minute window.");
        return;
      }
      validAttempts = filtered;
    }

    setDensityLoading(true);
    try {
      const coords = await geocodeArea(densityQuery);
      if (!coords) {
        alert("Area not found in Bengaluru. Please try another name.");
        return;
      }

      if (isServiceLimited('density')) {
        const newAttempts = [...validAttempts, now];
        setDensityAttempts(newAttempts);
        localStorage.setItem('gridlock_density_attempts', JSON.stringify(newAttempts));
      }

      if (mapRef.current) {
        mapRef.current.flyTo(coords);
        // Calculate destination bounds immediately for zoom 15
        const lat = coords.lat;
        const lng = coords.lng;
        const customBounds = [lat - 0.008, lng - 0.012, lat + 0.008, lng + 0.012];
        // Wait for map flyTo duration (1500ms)
        await new Promise(resolve => setTimeout(resolve, 1500));
        // Fetch traffic density data
        await mapRef.current.triggerTrafficFetch(customBounds, 15);
      }

    } catch (e) {
      alert("Search failed: " + e.message);
    } finally {
      setDensityLoading(false);
    }
  };

  const toggleDensitySearch = () => {
    if (!isServiceAllowed('density')) return;
    setShowDensitySearch(prev => {
      const next = !prev;
      if (next) {
        setShowRoutebar(false);
        setRouteData(null);
        setActiveDrawer(null);
        setShowReportForm(false);
        setMapClickCoords(null);
      } else {
        setDensityQuery('');
        if (mapRef.current) mapRef.current.clearTraffic();
      }
      return next;
    });
  };

  const toggleRoutePlanner = () => {
    if (!isServiceAllowed('routing')) return;
    setShowRoutebar(prev => {
      const next = !prev;
      if (next) {
        setShowDensitySearch(false);
        setDensityQuery('');
        if (mapRef.current) mapRef.current.clearTraffic();
        setActiveDrawer(null);
        setShowReportForm(false);
        setMapClickCoords(null);
      }
      return next;
    });
  };

  const toggleReportForm = () => {
    setShowReportForm(prev => {
      const next = !prev;
      if (next) {
        setActiveDrawer(null);
        setShowRoutebar(false);
        setShowDensitySearch(false);
        setDensityQuery('');
        if (mapRef.current) mapRef.current.clearTraffic();
      }
      setMapClickCoords(null);
      return next;
    });
  };

  // ── Admin Portal ──────────────────────────────────────────────────────────
  if (isAdminPortal) {
    return <AdminPanel user={currentUser} onLogin={(user) => setCurrentUser(user)} onLogout={handleSignOut} />;
  }

  // ── Login Screen ──────────────────────────────────────────────────────────
  if (!currentUser) {
    return (
      <div className="login-screen">
        <div className="login-card glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="login-logo">Grid<span>Lock</span> Sentinel</div>
          <p className="login-tagline" style={{ marginBottom: 20 }}>AI-Powered Traffic Intelligence for Bengaluru</p>
          
          <div id="google-signin-btn" style={{ display: 'flex', justifyContent: 'center' }} />
          
          <div className="login-divider">Or Continue With Demo Account</div>
          
          <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>
              Demo Login Roles
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              {/* Commuter Role Box */}
              <div 
                onClick={() => setSelectedDemoRole('Commuter')}
                style={{
                  flex: 1,
                  padding: '16px 10px',
                  borderRadius: '8px',
                  border: selectedDemoRole === 'Commuter' ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                  background: selectedDemoRole === 'Commuter' ? 'rgba(59, 130, 246, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8
                }}
                className="demo-role-box"
              >
                <Compass size={20} color={selectedDemoRole === 'Commuter' ? 'var(--accent)' : 'var(--text-muted)'} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: selectedDemoRole === 'Commuter' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  Commuter
                </span>
              </div>

              {/* Officer Role Box */}
              <div 
                onClick={() => setSelectedDemoRole('Officer')}
                style={{
                  flex: 1,
                  padding: '16px 10px',
                  borderRadius: '8px',
                  border: selectedDemoRole === 'Officer' ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                  background: selectedDemoRole === 'Officer' ? 'rgba(59, 130, 246, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8
                }}
                className="demo-role-box"
              >
                <Shield size={20} color={selectedDemoRole === 'Officer' ? 'var(--accent)' : 'var(--text-muted)'} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: selectedDemoRole === 'Officer' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  Officer
                </span>
              </div>

              {/* Admin Role Box */}
              <div 
                onClick={() => setSelectedDemoRole('Admin')}
                style={{
                  flex: 1,
                  padding: '16px 10px',
                  borderRadius: '8px',
                  border: selectedDemoRole === 'Admin' ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                  background: selectedDemoRole === 'Admin' ? 'rgba(59, 130, 246, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8
                }}
                className="demo-role-box"
              >
                <LayoutDashboard size={20} color={selectedDemoRole === 'Admin' ? 'var(--accent)' : 'var(--text-muted)'} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: selectedDemoRole === 'Admin' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  Admin
                </span>
              </div>
            </div>

            <button 
              onClick={() => handleDemoLogin(selectedDemoRole)}
              disabled={!selectedDemoRole || demoLoginLoading}
              className="btn btn-primary"
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: selectedDemoRole ? 'var(--accent)' : 'rgba(255, 255, 255, 0.05)',
                color: selectedDemoRole ? '#ffffff' : 'rgba(255, 255, 255, 0.25)',
                border: 'none',
                cursor: selectedDemoRole ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s ease',
                marginTop: 8
              }}
            >
              {demoLoginLoading ? 'Signing in...' : 'Sign in as Demo User'}
            </button>
          </div>

          {loginError && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8, marginBottom: 0 }}>{loginError}</p>}
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 16, marginBottom: 0 }}>
            Sign in with Google or select a Demo login role above.
          </p>
        </div>
      </div>
    );
  }

  // ── Main Dashboard ────────────────────────────────────────────────────────
  const isOfficer = ['Officer', 'Admin'].includes(currentUser.role);

  return (
    <div className="dashboard">
      {/* Full-screen Map */}
      <MapDashboard
        ref={mapRef}
        events={events}
        routeData={routeData}
        draftClosedRoute={draftClosedRoute}
        onMapRightClick={handleMapRightClick}
        onEventClick={handleEventClick}
        userLocation={userLocation}
        trafficOverlayAllowed={isServiceAllowed('density')}
        mapClickCoords={mapClickCoords}
        onMapClick={handleMapClick}
      />

      {mapSelectMode && (
        <div style={{
          position: 'absolute',
          top: '80px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
          background: 'rgba(15, 23, 42, 0.95)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius)',
          padding: '12px 20px',
          boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          gap: 16
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
            <MapPin size={16} className="pulse" color="var(--accent)" />
            <span>Select {mapSelectMode === 'route_start' ? 'Start Location' : (mapSelectMode === 'route_end' || mapSelectMode === 'create_event_end') ? 'End Location' : 'Location'} on Map</span>
            <div className="tooltip-container">
              <Info size={13} style={{ color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 4 }} />
              <div className="tooltip-text">
                Right-click / Long-press to select
              </div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => {
            if (mapSelectMode === 'report') setShowReportForm(true);
            else if (mapSelectMode === 'create_event' || mapSelectMode === 'create_event_end') setActiveDrawer('officer');
            else if (mapSelectMode === 'route_start' || mapSelectMode === 'route_end') setShowRoutebar(true);
            setMapSelectMode(null);
          }} style={{ fontSize: 11, padding: '4px 8px' }}>
            Cancel
          </button>
        </div>
      )}

      {/* Floating Header */}
      <div className="floating-header glass-panel">
        <div className="header-left">
          <Shield size={18} color="var(--accent)" />
          <div className="header-brand">Grid<span>Lock</span></div>
        </div>
        <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {!isMobileView && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={() => setShowHowToUseModal(true)}
                style={{ border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500 }}
              >
                How to Use
              </button>
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={() => setShowSettingsModal(true)}
                style={{ border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500 }}
              >
                Controls
              </button>
              {currentUser.role === 'Admin' && (
                <button 
                  className="btn btn-ghost btn-sm" 
                  onClick={() => window.location.hash = '#/admin-portal'}
                  style={{ border: 'none', background: 'none', color: 'var(--accent-light)', fontSize: 13, fontWeight: 600 }}
                >
                  Admin Portal
                </button>
              )}
            </div>
          )}

          {/* Account indicator badge & avatar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`badge ${currentUser.role === 'Officer' ? 'badge-purple' : currentUser.role === 'Admin' ? 'badge-red' : 'badge-blue'}`}>
              {currentUser.role}
            </span>
            
            {/* Account Icon + Attached Dropdown Menu */}
            <div style={{ position: 'relative' }}>
              <button 
                onClick={() => setShowAccountMenu(prev => !prev)} 
                className="user-avatar-btn"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  color: 'white',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  padding: 0
                }}
              >
                {currentUser.profile_picture ? <img src={currentUser.profile_picture} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : currentUser.name?.[0]?.toUpperCase() || 'U'}
              </button>
              
              {showAccountMenu && (
                <>
                  <div 
                    onClick={() => setShowAccountMenu(false)} 
                    style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} 
                  />
                  <div 
                    className="glass-card" 
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: 44,
                      width: 200,
                      padding: 14,
                      zIndex: 1000,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      animation: 'fadeInScale 0.15s ease'
                    }}
                  >
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {currentUser.name || 'User'}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                        {currentUser.email || ''}
                      </div>
                    </div>
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                      <button 
                        className="btn btn-danger btn-sm" 
                        onClick={() => {
                          setShowAccountMenu(false);
                          handleSignOut();
                        }}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 10px', fontSize: 11 }}
                      >
                        <LogOut size={12} /> Sign Out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Mobile Hamburger menu trigger */}
            {isMobileView && (
              <button 
                className="btn btn-ghost" 
                onClick={() => setShowMobileMenu(prev => !prev)}
                style={{ padding: 8, minWidth: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none' }}
              >
                {showMobileMenu ? <X size={18} /> : <Menu size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>

      {showRoutebar && isServiceAllowed('routing') && (
        <div className="route-search-panel glass-card">
          {routeLoading && <LoadingSpinner message="Calculating fastest route..." />}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Navigation size={14} color="var(--accent)" /> Route Planner
            </span>
            <button className="drawer-close" onClick={() => { setShowRoutebar(false); setRouteData(null); }} style={{ width: 24, height: 24 }}>
              <X size={12} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                <MapPin size={14} color="var(--success)" /> START LOCATION
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input" style={{ flex: 1 }} placeholder="Location name or Lat, Lng" value={routeSource} onChange={(e) => setRouteSource(e.target.value)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleRouteSourceGps} title="Use GPS Location" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <Compass size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleStartMapSelect('route_start')} title="Select on Map" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <MapPin size={14} />
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                <MapPin size={14} color="var(--danger)" /> END LOCATION
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input" style={{ flex: 1 }} placeholder="Location name or Lat, Lng" value={routeDest} onChange={(e) => setRouteDest(e.target.value)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleRouteDestGps} title="Use GPS Location" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <Compass size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleStartMapSelect('route_end')} title="Select on Map" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <MapPin size={14} />
                  </button>
                </div>
              </div>
            </div>

            {isServiceLimited('routing') && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                <span>Route calculations remaining:</span>
                <span style={{ fontWeight: 600, color: (3 - routeAttempts.length) === 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {3 - routeAttempts.length} / 3 {routeTimeLeft && `(Reset in ${routeTimeLeft})`}
                </span>
              </div>
            )}

            <button className="btn btn-primary" onClick={handleFindRoute} disabled={routeLoading}>
              {routeLoading ? 'Calculating...' : 'Find Fastest Route'}
            </button>
          </div>

          {routeData && routeData.normal_route && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Route Options</div>
              
              <div className="route-row">
                <div className="route-label">
                  <div className="route-dot" style={{ background: '#3b82f6' }} />
                  <span>Normal Route</span>
                </div>
                <div className="route-stats">
                  <div>{routeData.normal_route.duration_mins} mins</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{(routeData.normal_route.distance_m / 1000).toFixed(1)} km</div>
                </div>
              </div>

              {routeData.safe_route && routeData.intersects_hazard && (
                <div className="route-row">
                  <div className="route-label">
                    <div className="route-dot" style={{ background: '#22c55e' }} />
                    <span>Safe Route</span>
                  </div>
                  <div className="route-stats">
                    <div>{routeData.safe_route.duration_mins} mins</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{(routeData.safe_route.distance_m / 1000).toFixed(1)} km</div>
                  </div>
                </div>
              )}

              {routeData.intersects_hazard && (
                <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.4 }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                  <span>Avoids active incident: {routeData.incident_cause?.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showDensitySearch && isServiceAllowed('density') && (
        <div className="density-search-panel glass-card" style={{ display: mapSelectMode === 'density_select' ? 'none' : 'block' }}>
          {densityLoading && <LoadingSpinner message="Fetching traffic density..." />}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Search size={14} color="var(--accent)" /> Traffic Density Search
            </span>
            <button className="drawer-close" onClick={toggleDensitySearch} style={{ width: 24, height: 24 }}>
              <X size={12} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <span className="label">Bengaluru Area Name or Coordinates</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input" style={{ flex: 1 }} placeholder="e.g. Koramangala or Lat, Lng" value={densityQuery} onChange={(e) => setDensityQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleDensitySearch()} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleDensityGps} title="Use GPS Location" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <Compass size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleStartMapSelect('density_select')} title="Select on Map" style={{ padding: '8px', minWidth: '36px', height: '36px', borderRadius: 'var(--radius)' }}>
                    <MapPin size={14} />
                  </button>
                </div>
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleDensitySearch} disabled={densityLoading}>
              {densityLoading ? 'Searching...' : 'Search Traffic'}
            </button>
          </div>

          {/* Rate limits / timer status */}
          {(isServiceLimited('density') || !isServiceAllowed('density')) && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              {isServiceLimited('density') && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span>Searches Remaining:</span>
                    <span style={{ fontWeight: 600, color: (3 - densityAttempts.length) === 0 ? 'var(--danger)' : 'var(--success)' }}>
                      {3 - densityAttempts.length} / 3
                    </span>
                  </div>
                  {densityTimeLeft && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      <span>Limit resets in:</span>
                      <span style={{ fontFamily: 'JetBrains Mono' }}>{densityTimeLeft}</span>
                    </div>
                  )}
                </>
              )}
              
              {/* Show admin disabled overlay status if globally/role disabled */}
              {!isServiceAllowed('density') && (
                <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.15)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239,68,68,0.3)', fontSize: 11, color: '#fca5a5', lineHeight: 1.4 }}>
                  ⚠️ Service is currently disabled by the System Administrator.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="action-buttons">
        <button className="action-btn" onClick={handleLocateMe} title="Locate Me">
          <Crosshair size={18} />
        </button>
        <button 
          className={`action-btn ${showRoutebar ? 'active' : ''}`} 
          onClick={() => isServiceAllowed('routing') && toggleRoutePlanner()} 
          title="Route Planner"
          disabled={!isServiceAllowed('routing')}
          style={{
            opacity: isServiceAllowed('routing') ? 1 : 0.4,
            cursor: isServiceAllowed('routing') ? 'pointer' : 'not-allowed'
          }}
        >
          <Navigation size={18} />
        </button>
        <button 
          className={`action-btn ${showDensitySearch ? 'active' : ''}`} 
          onClick={() => isServiceAllowed('density') && toggleDensitySearch()} 
          title="Traffic Search"
          disabled={!isServiceAllowed('density')}
          style={{
            opacity: isServiceAllowed('density') ? 1 : 0.4,
            cursor: isServiceAllowed('density') ? 'pointer' : 'not-allowed'
          }}
        >
          <Search size={18} />
        </button>
        {!isOfficer && (
          <button className={`action-btn ${showReportForm ? 'active' : ''}`} onClick={toggleReportForm} title="Report Incident">
            <AlertTriangle size={18} />
          </button>
        )}
        {!isOfficer && (
          <button className={`action-btn ${activeDrawer === 'events' ? 'active' : ''}`} onClick={() => toggleDrawer('events')} title="Events">
            <List size={18} />
          </button>
        )}
        {isOfficer && (
          <button className={`action-btn ${activeDrawer === 'officer' ? 'active' : ''}`} onClick={() => toggleDrawer('officer')} title="Officer Panel">
            <Shield size={18} />
          </button>
        )}
        <button className={`action-btn ${activeDrawer === 'analytics' ? 'active' : ''}`} onClick={() => toggleDrawer('analytics')} title="Analytics">
          <BarChart3 size={18} />
        </button>
        <button className={`action-btn ${activeDrawer === 'historical' ? 'active' : ''}`} onClick={() => toggleDrawer('historical')} title="Historical Analytics">
          <Calendar size={18} />
        </button>
        <button 
          className={`action-btn ${activeDrawer === 'chat' ? 'active' : ''}`} 
          onClick={() => isServiceAllowed('chatbot') && toggleDrawer('chat')} 
          title="AI Chat"
          disabled={!isServiceAllowed('chatbot')}
          style={{
            opacity: isServiceAllowed('chatbot') ? 1 : 0.4,
            cursor: isServiceAllowed('chatbot') ? 'pointer' : 'not-allowed'
          }}
        >
          <MessageCircle size={18} />
        </button>
      </div>

      {/* Side Drawers */}
      {activeDrawer && (
        <>
          <div className="drawer-overlay" onClick={() => setActiveDrawer(null)} style={{ display: (mapSelectMode === 'create_event' || mapSelectMode === 'create_event_end') ? 'none' : 'block' }} />
          <div className="side-drawer" style={{ display: (mapSelectMode === 'create_event' || mapSelectMode === 'create_event_end') ? 'none' : 'flex' }}>
            {activeDrawer === 'events' && (
               <>
                 <div className="drawer-header">
                   <div>
                     <div className="drawer-title">Active Events</div>
                     {isServiceLimited('ai_suggestion') && (
                       <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                         AI Suggestions: <span style={{ fontWeight: 600, color: (3 - aiSuggestionAttempts.length) === 0 ? 'var(--danger)' : 'var(--success)' }}>
                           {3 - aiSuggestionAttempts.length} / 3 {aiSuggestionTimeLeft && `(Reset in ${aiSuggestionTimeLeft})`}
                         </span>
                       </div>
                     )}
                   </div>
                   <button className="drawer-close" onClick={() => setActiveDrawer(null)}><X size={16} /></button>
                 </div>
                 <div className="drawer-body" style={{ position: 'relative' }}>
                    {aiSuggestionLoading && <LoadingSpinner message="Generating AI suggestions..." />}
                    {events.length === 0 ? (
                      <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No active events</p>
                    ) : events.map(ev => (
                      <div 
                        key={ev.id} 
                        id={`commuter-event-card-${ev.id}`}
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
                        <div className="event-card-meta">
                          <Clock size={11} /> {ev.current_clearance_time_mins} mins · <span className={`badge badge-sm ${ev.priority === 'High' ? 'badge-red' : ev.priority === 'Medium' ? 'badge-yellow' : 'badge-green'}`}>{ev.priority}</span>
                        </div>
                        <div className="event-card-actions" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                          <button 
                            className="btn btn-primary btn-sm" 
                            onClick={() => isServiceAllowed('ai_suggestion') && handleShowActiveEventSuggestions(ev)}
                            disabled={!isServiceAllowed('ai_suggestion')}
                            style={{
                              opacity: isServiceAllowed('ai_suggestion') ? 1 : 0.4,
                              cursor: isServiceAllowed('ai_suggestion') ? 'pointer' : 'not-allowed'
                            }}
                          >
                            <Zap size={12} /> AI Suggestion
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
               </>
             )}

            {activeDrawer === 'officer' && (
              <OfficerPanel
                events={events}
                reports={reports}
                selectedEventId={selectedEventId}
                mapEventStartCoords={mapEventStartCoords}
                mapEventEndCoords={mapEventEndCoords}
                onClearEventStartCoords={() => setMapEventStartCoords(null)}
                onClearEventEndCoords={() => setMapEventEndCoords(null)}
                onClose={() => { setActiveDrawer(null); setDraftClosedRoute(null); }}
                onRefresh={async () => {
                  try { setEvents(await api.getEvents('active')); setReports(await api.getReports()); } catch(e) {}
                }}
                onShowAiSuggestion={(data) => {
                  if (data) {
                    const zoneVal = data.zone_type || (data.requires_road_closure ? 'Red' : 'Yellow');
                    setAiSuggestionData({
                      ...data,
                      zone_type: zoneVal,
                      requires_road_closure: !!data.requires_road_closure,
                      delay_mins: data.delay_mins !== undefined ? data.delay_mins : 0
                    });
                    setShowAiSuggestionModal(true);
                  } else {
                    setAiSuggestionData(null);
                    setShowAiSuggestionModal(false);
                  }
                }}
                onSetRouteData={(route) => setRouteData(route)}
                onSetDraftClosedRoute={(geometry) => setDraftClosedRoute(geometry)}
                userLocation={userLocation}
                onLocateOnMap={handleLocateOnMap}
                onStartMapSelect={handleStartMapSelect}
                isServiceAllowed={isServiceAllowed}
                isServiceLimited={isServiceLimited}
                aiSuggestionAttempts={aiSuggestionAttempts}
                aiSuggestionTimeLeft={aiSuggestionTimeLeft}
                onRecordAttempt={handleRecordAttempt}
              />
            )}

            {activeDrawer === 'analytics' && (
              <AnalyticsDashboard onClose={() => setActiveDrawer(null)} />
            )}

            {activeDrawer === 'historical' && (
              <HistoricalAnalyticsDashboard onClose={() => setActiveDrawer(null)} />
            )}
            {activeDrawer === 'chat' && isServiceAllowed('chatbot') && (
              <>
                <div className="drawer-header">
                  <div>
                    <div className="drawer-title">AI Assistant</div>
                    {isServiceLimited('chatbot') && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        Messages: <span style={{ fontWeight: 600, color: (3 - chatAttempts.length) === 0 ? 'var(--danger)' : 'var(--success)' }}>
                          {3 - chatAttempts.length} / 3 {chatTimeLeft && `(Reset in ${chatTimeLeft})`}
                        </span>
                      </div>
                    )}
                  </div>
                  <button className="drawer-close" onClick={() => setActiveDrawer(null)}><X size={16} /></button>
                </div>
                <div className="drawer-body">
                  <div className="chat-messages">
                    {chatMessages.length === 0 && (
                      <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40, fontSize: 13 }}>
                        Ask me about Bengaluru traffic, routes, or active incidents.
                      </p>
                    )}
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`chat-bubble ${m.role === 'user' ? 'chat-user' : 'chat-bot'}`}>
                        {m.role === 'user' ? m.text : renderMarkdown(m.text)}
                      </div>
                    ))}
                    {chatLoading && <div className="chat-bubble chat-bot" style={{ opacity: 0.6 }}>Thinking...</div>}
                  </div>
                  <div className="chat-input-bar">
                    <input className="input" placeholder="Ask about traffic..." value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSendChat()} />
                    <button className="btn btn-primary" onClick={handleSendChat} disabled={chatLoading}>
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Report Form (Floating) */}
      {showReportForm && (
        <div style={{ display: mapSelectMode === 'report' ? 'none' : 'block' }}>
          <TravelerPanel
            coords={mapClickCoords}
            events={events}
            onClose={() => { setShowReportForm(false); setMapClickCoords(null); }}
            onSubmitted={async () => {
              setShowReportForm(false);
              setMapClickCoords(null);
              try { setEvents(await api.getEvents('active')); } catch(e) {}
            }}
            userRole={currentUser.role}
            userLocation={userLocation}
            onLocateOnMap={handleLocateOnMap}
            onStartMapSelect={handleStartMapSelect}
          />
        </div>
      )}

      {/* AI Suggestion Modal */}
      {showAiSuggestionModal && aiSuggestionData && (
        <div className="ai-modal-overlay">
          <div className="ai-modal glass-card">
            <div className="ai-modal-header">
              <h3>
                <Zap size={16} color="var(--accent)" style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                AI Operational Blueprint & Suggestions
              </h3>
              <button className="ai-modal-close" onClick={() => setShowAiSuggestionModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="ai-modal-body">
              {(() => {
                const getTheme = (cause = '') => {
                  const c = cause.toLowerCase();
                  if (c.includes('breakdown') || c.includes('vehicle')) {
                    return {
                      color: '#f59e0b',
                      bg: 'rgba(245, 158, 11, 0.08)',
                      border: 'rgba(245, 158, 11, 0.25)',
                      iconBg: 'rgba(245, 158, 11, 0.15)',
                      icon: <Zap size={18} color="#f59e0b" />
                    };
                  }
                  if (c.includes('accident')) {
                    return {
                      color: '#ef4444',
                      bg: 'rgba(239, 68, 68, 0.08)',
                      border: 'rgba(239, 68, 68, 0.25)',
                      iconBg: 'rgba(239, 68, 68, 0.15)',
                      icon: <AlertTriangle size={18} color="#ef4444" />
                    };
                  }
                  if (c.includes('water') || c.includes('rain') || c.includes('flood')) {
                    return {
                      color: '#3b82f6',
                      bg: 'rgba(59, 130, 246, 0.08)',
                      border: 'rgba(59, 130, 246, 0.25)',
                      iconBg: 'rgba(59, 130, 246, 0.15)',
                      icon: <Info size={18} color="#3b82f6" />
                    };
                  }
                  if (c.includes('tree')) {
                    return {
                      color: '#10b981',
                      bg: 'rgba(16, 185, 129, 0.08)',
                      border: 'rgba(16, 185, 129, 0.25)',
                      iconBg: 'rgba(16, 185, 129, 0.15)',
                      icon: <AlertTriangle size={18} color="#10b981" />
                    };
                  }
                  if (c.includes('construction') || c.includes('repair')) {
                    return {
                      color: '#f97316',
                      bg: 'rgba(249, 115, 22, 0.08)',
                      border: 'rgba(249, 115, 22, 0.25)',
                      iconBg: 'rgba(249, 115, 22, 0.15)',
                      icon: <Settings size={18} color="#f97316" />
                    };
                  }
                  if (c.includes('pothole') || c.includes('road')) {
                    return {
                      color: '#a855f7',
                      bg: 'rgba(168, 85, 247, 0.08)',
                      border: 'rgba(168, 85, 247, 0.25)',
                      iconBg: 'rgba(168, 85, 247, 0.15)',
                      icon: <AlertTriangle size={18} color="#a855f7" />
                    };
                  }
                  return {
                    color: '#6366f1',
                    bg: 'rgba(99, 102, 241, 0.08)',
                    border: 'rgba(99, 102, 241, 0.25)',
                    iconBg: 'rgba(99, 102, 241, 0.15)',
                    icon: <AlertTriangle size={18} color="#6366f1" />
                  };
                };

                const theme = getTheme(aiSuggestionData.event_cause);
                const priority = (aiSuggestionData.priority || 'medium').toLowerCase();
                const prioColor = priority === 'high' || priority === 'critical' ? '#ef4444' : priority === 'medium' ? '#f59e0b' : '#3b82f6';
                const prioBg = priority === 'high' || priority === 'critical' ? 'rgba(239, 68, 68, 0.12)' : priority === 'medium' ? 'rgba(245, 158, 11, 0.12)' : 'rgba(59, 130, 246, 0.12)';

                return (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    gap: '16px 24px',
                    padding: '16px 20px',
                    background: 'rgba(30, 41, 59, 0.25)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    marginBottom: '24px',
                    alignItems: 'center',
                    fontFamily: 'Inter, sans-serif'
                  }}>
                    {/* Event Cause / Classification */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '160px' }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: theme.iconBg,
                        border: `1px solid ${theme.border}`,
                        padding: '6px',
                        borderRadius: '8px',
                        boxShadow: `0 0 8px ${theme.bg}`
                      }}>
                        {theme.icon}
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.6px' }}>
                          Event Cause
                        </div>
                        <div style={{ fontSize: '14px', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {((aiSuggestionData.event_cause || 'others').replace(/_/g, ' ')).replace(/\b\w/g, c => c.toUpperCase())}
                        </div>
                      </div>
                    </div>

                    {/* Priority */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '110px' }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: prioBg,
                        border: `1px solid ${prioColor}33`,
                        padding: '6px',
                        borderRadius: '8px'
                      }}>
                        <AlertTriangle size={16} color={prioColor} />
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.6px' }}>
                          Priority
                        </div>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: '700',
                          color: prioColor,
                          textTransform: 'uppercase'
                        }}>
                          {priority}
                        </span>
                      </div>
                    </div>

                    {/* Location Address */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 200px', minWidth: '200px' }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.2)',
                        padding: '6px',
                        borderRadius: '8px'
                      }}>
                        <MapPin size={16} color="#ef4444" />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.6px' }}>
                          Location Address
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={aiSuggestionData.address || 'Bengaluru, Karnataka'}>
                          {aiSuggestionData.address || 'Bengaluru, Karnataka'}
                        </div>
                      </div>
                    </div>

                    {/* Start Coordinates */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '160px' }}>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(16, 185, 129, 0.1)',
                        border: '1px solid rgba(16, 185, 129, 0.2)',
                        padding: '6px',
                        borderRadius: '8px'
                      }}>
                        <Compass size={16} color="#10b981" />
                      </div>
                      <div>
                        <div style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.6px' }}>
                          Start Coordinates
                        </div>
                        <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--accent-light)', fontWeight: '600' }}>
                          {aiSuggestionData.latitude?.toFixed(6)}, {aiSuggestionData.longitude?.toFixed(6)}
                        </div>
                      </div>
                    </div>

                    {/* End Coordinates */}
                    {aiSuggestionData.endlatitude && aiSuggestionData.endlongitude && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '160px' }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'rgba(16, 185, 129, 0.1)',
                          border: '1px solid rgba(16, 185, 129, 0.2)',
                          padding: '6px',
                          borderRadius: '8px'
                        }}>
                          <Compass size={16} color="#10b981" />
                        </div>
                        <div>
                          <div style={{ fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.6px' }}>
                            End Coordinates
                          </div>
                          <div style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--accent-light)', fontWeight: '600' }}>
                            {parseFloat(aiSuggestionData.endlatitude)?.toFixed(6)}, {parseFloat(aiSuggestionData.endlongitude)?.toFixed(6)}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Minimap rendering the detour and active events */}
              {aiSuggestionData.latitude && aiSuggestionData.longitude && (
                <div style={{ marginTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Interactive Detour Preview
                  </div>
                  <MiniMap 
                    key={`${aiSuggestionData.latitude}-${aiSuggestionData.longitude}-${aiSuggestionData.endlatitude || ''}-${aiSuggestionData.endlongitude || ''}-${aiSuggestionData.requires_road_closure}-${aiSuggestionData.zone_type || ''}`}
                    lat={aiSuggestionData.latitude} 
                    lng={aiSuggestionData.longitude} 
                    endLat={aiSuggestionData.endlatitude}
                    endLng={aiSuggestionData.endlongitude}
                    routeData={aiSuggestionData.routeData} 
                    events={events}
                    zoneType={aiSuggestionData.zone_type}
                  />

                  {aiSuggestionData.routeData && (
                    <div style={{
                      marginTop: 12,
                      background: 'rgba(30, 41, 59, 0.4)',
                      border: '1px solid var(--border)',
                      borderRadius: '12px',
                      padding: '16px',
                      boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.05)',
                      fontFamily: 'Inter, sans-serif'
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-secondary)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Navigation size={12} color="var(--accent)" />
                        Route Profiles & Comparison
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {aiSuggestionData.routeData.normal_route && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 12, height: 4, background: '#3b82f6', borderRadius: 2 }} />
                              <span style={{ fontWeight: 600, color: '#f1f5f9' }}>Normal Route</span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> (Passes epicenter)</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ color: '#94a3b8' }}>
                                {((aiSuggestionData.routeData.normal_route.distance_m || 0) / 1000).toFixed(2)} km
                              </span>
                              <span style={{ fontWeight: 600, color: '#f1f5f9' }}>
                                {aiSuggestionData.routeData.normal_route.duration_mins} mins
                              </span>
                              {aiSuggestionData.requires_road_closure ? (
                                <span className="badge badge-red" style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                  inaccessible
                                </span>
                              ) : (
                                aiSuggestionData.delay_mins > 0 && (
                                  <span className="badge badge-yellow" style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                    +{aiSuggestionData.delay_mins}m delay
                                  </span>
                                )
                              )}
                            </div>
                          </div>
                        )}
                        {aiSuggestionData.routeData.safe_route && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, borderBottom: (aiSuggestionData.requires_road_closure && aiSuggestionData.routeData.closed_route) ? '1px solid rgba(255,255,255,0.03)' : 'none', paddingBottom: (aiSuggestionData.requires_road_closure && aiSuggestionData.routeData.closed_route) ? 8 : 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 12, height: 4, background: '#22c55e', border: '1px dashed #22c55e', borderRadius: 2 }} />
                              <span style={{ fontWeight: 600, color: '#f1f5f9' }}>Detour Route</span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> (Skips epicenter)</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ color: '#94a3b8' }}>
                                {((aiSuggestionData.routeData.safe_route.distance_m || 0) / 1000).toFixed(2)} km
                              </span>
                              <span style={{ fontWeight: 600, color: '#22c55e' }}>
                                {aiSuggestionData.routeData.safe_route.duration_mins} mins
                              </span>
                              <span className="badge badge-green" style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                Detour active
                              </span>
                            </div>
                          </div>
                        )}
                        {aiSuggestionData.requires_road_closure && aiSuggestionData.routeData.closed_route && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 12, height: 4, background: '#ef4444', borderRadius: 2 }} />
                              <span style={{ fontWeight: 600, color: '#f1f5f9' }}>Closed Corridor Segment</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ color: '#94a3b8' }}>
                                {((aiSuggestionData.routeData.closed_route.distance_m || 0) / 1000).toFixed(2)} km
                              </span>
                              <span className="badge badge-red" style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                Fully Blocked
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <hr className="chat-hr" />
              
              {/* Markdown content */}
              <div className="ai-suggestion-content">
                {renderMarkdown(aiSuggestionData.markdown_content)}
              </div>
            </div>
            <div className="ai-modal-footer">
              <button className="btn btn-primary" onClick={() => setShowAiSuggestionModal(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {showHowToUseModal && (
        <div className="ai-modal-overlay" onClick={() => setShowHowToUseModal(false)}>
          <div className="ai-modal glass-card" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
            <div className="ai-modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <Info size={16} color="var(--accent)" />
                How to Use GridLock Sentinel
              </h3>
              <button className="ai-modal-close" onClick={() => setShowHowToUseModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="ai-modal-body" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', margin: '0 0 4px 0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🚗 Traveler / Commuter features</h4>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <li><strong>Traffic Density:</strong> Use the search panel on the right to geocode or enter coordinates. It flies to the area and overlays TomTom traffic conditions.</li>
                    <li><strong>Route Planner:</strong> Enter a start and end location to find the fastest routes, which automatically detour around active incidents.</li>
                    <li><strong>Report Incidents:</strong> Click the warning triangle button or right-click on the map to file an active traffic report (waterlogging, accident, etc.).</li>
                    <li><strong>AI Chatbot:</strong> Open the chat tab in the sidebar to ask questions about traffic, regulations, or routes.</li>
                  </ul>
                </div>
                
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: '#a855f7', margin: '0 0 4px 0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>👮 Traffic Officer features</h4>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <li><strong>Create Event:</strong> Open the Officer Panel to log a verified traffic event on the map.</li>
                    <li><strong>AI Suggestions:</strong> Click "AI Suggestion" to automatically populate event priorities, initial clearance estimations, detour calculations, and officer instructions.</li>
                    <li><strong>ML Clearance Prediction:</strong> Click the clock icon next to clearance time to confirm inputs and run the ML prediction model.</li>
                    <li><strong>Verify Reports:</strong> Review reports submitted by commuters in the Reports tab to promote them into official events.</li>
                  </ul>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)', margin: '0 0 4px 0', textTransform: 'uppercase', letterSpacing: '0.5px' }}>🛡️ Administrator Console</h4>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <li><strong>User Management:</strong> Select tab inside the Admin Portal to promote or demote user roles between Commuter and Officer.</li>
                    <li><strong>Service Controls:</strong> Enable or disable chatbot, routing, and search services globally, or configure custom role permissions.</li>
                  </ul>
                </div>
              </div>
            </div>
            <div className="ai-modal-footer">
              <button className="btn btn-primary" onClick={() => setShowHowToUseModal(false)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {isMobileView && showMobileMenu && (
        <>
          <div 
            onClick={() => setShowMobileMenu(false)} 
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} 
          />
          <div 
            className="glass-card" 
            style={{
              position: 'fixed',
              top: 76,
              left: 16,
              right: 16,
              zIndex: 999,
              padding: '12px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              animation: 'slideUp var(--transition)'
            }}
          >
            <button 
              className="btn btn-ghost" 
              onClick={() => { setShowMobileMenu(false); setShowHowToUseModal(true); }}
              style={{ justifyContent: 'flex-start', border: 'none', width: '100%', padding: '8px 0', fontSize: 13 }}
            >
              How to Use
            </button>
            <button 
              className="btn btn-ghost" 
              onClick={() => { setShowMobileMenu(false); setShowSettingsModal(true); }}
              style={{ justifyContent: 'flex-start', border: 'none', width: '100%', padding: '8px 0', fontSize: 13 }}
            >
              Controls
            </button>
            {currentUser.role === 'Admin' && (
              <button 
                className="btn btn-ghost" 
                onClick={() => { setShowMobileMenu(false); window.location.hash = '#/admin-portal'; }}
                style={{ justifyContent: 'flex-start', border: 'none', width: '100%', padding: '8px 0', fontSize: 13, color: 'var(--accent-light)', fontWeight: 600 }}
              >
                Admin Portal
              </button>
            )}
          </div>
        </>
      )}

      {showSettingsModal && (
        <div className="ai-modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="ai-modal glass-card" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="ai-modal-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <Settings size={16} color="var(--accent)" />
                Map Controls Guide
              </h3>
              <button className="ai-modal-close" onClick={() => setShowSettingsModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="ai-modal-body" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {isMobileView ? (
                <>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                    You are in <strong>Mobile View</strong>. The map supports touch controls optimized for your device:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
                        👆
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Drag / Pan</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Drag with one finger to move around the map.</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(34, 197, 94, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 'bold', color: '#22c55e', flexShrink: 0 }}>
                        PINCH
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Zoom In / Out</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Pinch open to zoom in, pinch closed to zoom out.</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(168, 85, 247, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 'bold', color: '#a855f7', flexShrink: 0 }}>
                        TWO
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Rotate & Pitch</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Use two fingers to rotate the map or adjust tilt/pitch angle.</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
                        ⏳
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Long Press (Press & Hold)</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Press and hold on any location to drop a marker or select coordinates.</div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                    You are in <strong>Laptop / Desktop View</strong>. Use mouse and keyboard shortcuts to navigate the map:
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
                        🖱️
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Drag / Pan</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Left-click and drag to move around the map.</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(34, 197, 94, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 'bold', color: '#22c55e', flexShrink: 0 }}>
                        SCRL
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Zoom In / Out</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Use your mouse scroll wheel, or click the + and - controls.</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 'bold', color: '#ef4444', flexShrink: 0 }}>
                        RGHT
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Right-Click</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Right-click on any location to drop a marker or select coordinates.</div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="ai-modal-footer">
              <button className="btn btn-primary" onClick={() => setShowSettingsModal(false)}>
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
