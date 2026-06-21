import { useState, useEffect } from 'react';
import { X, Send, MapPin, AlertTriangle, Clock, Navigation, Compass } from 'lucide-react';
import { api } from '../utils/api';

const EVENT_CAUSES = [
  'vehicle_breakdown', 'accident', 'water_logging', 'tree_fall', 'construction',
  'road_conditions', 'debris', 'congestion', 'pot_holes', 'public_event',
  'vip_movement', 'procession', 'protest', 'others'
];

export default function TravelerPanel({ coords, events = [], onClose, onSubmitted, userRole, userLocation, onLocateOnMap, onStartMapSelect }) {
  const [form, setForm] = useState({
    event_cause: 'congestion',
    description: '',
    latitude: coords?.lat?.toFixed(6) || '',
    longitude: coords?.lng?.toFixed(6) || ''
  });

  useEffect(() => {
    if (coords) {
      setForm(prev => ({
        ...prev,
        latitude: coords.lat.toFixed(6),
        longitude: coords.lng.toFixed(6)
      }));
    }
  }, [coords]);

  const handleUseGps = () => {
    if (userLocation) {
      setForm(prev => ({
        ...prev,
        latitude: userLocation.lat.toFixed(6),
        longitude: userLocation.lng.toFixed(6)
      }));
      if (onLocateOnMap) {
        onLocateOnMap(userLocation.lat, userLocation.lng);
      }
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          setForm(prev => ({
            ...prev,
            latitude: lat.toFixed(6),
            longitude: lng.toFixed(6)
          }));
          if (onLocateOnMap) {
            onLocateOnMap(lat, lng);
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
      onStartMapSelect('report');
    }
  };
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!form.latitude || !form.longitude) {
      alert('Please right-click on the map to set location, or enter coordinates.');
      return;
    }
    setLoading(true);
    try {
      await api.createReport({
        latitude: parseFloat(form.latitude),
        longitude: parseFloat(form.longitude),
        event_cause: form.event_cause,
        description: form.description
      });
      setSubmitted(true);
      setTimeout(() => { if (onSubmitted) onSubmitted(); }, 1500);
    } catch (e) {
      alert('Failed to submit report: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="report-form-overlay glass-card" style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Report Submitted!</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
          Thank you for reporting. An officer will review your report shortly.
        </div>
      </div>
    );
  }

  return (
    <div className="report-form-overlay glass-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} color="var(--warning)" /> Report Incident
        </div>
        <button className="drawer-close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="form-grid">
        <div className="full-width">
          <label className="label">What happened?</label>
          <select className="input" value={form.event_cause} onChange={e => setForm({ ...form, event_cause: e.target.value })}>
            {EVENT_CAUSES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase())}</option>)}
          </select>
        </div>
        <div className="full-width" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label className="label">Latitude</label>
            <input className="input" type="number" step="any" value={form.latitude}
              onChange={e => setForm({ ...form, latitude: e.target.value })} placeholder="12.9716" />
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">Longitude</label>
            <input className="input" type="number" step="any" value={form.longitude}
              onChange={e => setForm({ ...form, longitude: e.target.value })} placeholder="77.5946" />
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
          <label className="label">Description (optional)</label>
          <textarea className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="Describe what you see..." rows={3} />
        </div>
      </div>

      {coords && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
          <MapPin size={10} /> Location set from map click
        </div>
      )}

      <button className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} onClick={handleSubmit} disabled={loading}>
        {loading ? 'Submitting...' : <><Send size={14} /> Submit Report</>}
      </button>

      {/* Nearby Events */}
      {events.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Nearby Active Events
          </div>
          {events.slice(0, 5).map(ev => (
            <div key={ev.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
              borderBottom: '1px solid var(--border)', fontSize: 13
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: ev.zone_type === 'Red' ? 'var(--danger)' : 'var(--warning)'
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{(ev.event_cause || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  <Clock size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> {ev.current_clearance_time_mins} mins
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
