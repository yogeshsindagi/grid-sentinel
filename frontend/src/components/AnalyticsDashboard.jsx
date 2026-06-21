import { useState, useEffect } from 'react';
import { X, BarChart3, TrendingUp, Clock, MapPin, AlertTriangle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { api } from '../utils/api';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4', '#ef4444', '#f97316'];

export default function AnalyticsDashboard({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const d = await api.getAnalytics();
      setData(d);
    } catch (e) {
      console.error('Analytics fetch failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const customTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)',
        boxShadow: 'var(--shadow-sm)'
      }}>
        {payload.map((p, i) => (
          <div key={i}><span style={{ color: p.color || 'var(--accent)' }}>●</span> {p.name || p.dataKey}: <strong>{p.value}</strong></div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="drawer-header">
        <div className="drawer-title">
          <BarChart3 size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
          Analytics
        </div>
        <button className="drawer-close" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="drawer-body">
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading analytics...</div>
        ) : !data ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>No analytics data available</div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="stats-grid">
              <div className="glass-card stat-card">
                <div className="stat-value">{data.summary?.total_events || 0}</div>
                <div className="stat-label">Total Events</div>
              </div>
              <div className="glass-card stat-card">
                <div className="stat-value" style={{ color: 'var(--danger)' }}>{data.summary?.active_events || 0}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="glass-card stat-card">
                <div className="stat-value" style={{ color: 'var(--success)' }}>{data.summary?.resolved_events || 0}</div>
                <div className="stat-label">Resolved</div>
              </div>
            </div>

            {/* Event Causes Pie Chart */}
            {data.causes?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} color="var(--warning)" /> Event Causes
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.causes.map(c => ({ name: (c.cause || 'unknown').replace(/_/g, ' '), value: c.count }))}
                      cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                      {data.causes.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={customTooltip} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {data.causes.slice(0, 6).map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[i % CHART_COLORS.length] }} />
                      {(c.cause || '').replace(/_/g, ' ')} ({c.count})
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Hourly Distribution */}
            {data.hourly_distribution?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Clock size={14} color="var(--accent)" /> Hourly Distribution
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Shows when incidents occur throughout the day (24-hour clock: 0h = midnight, 12h = noon, 23h = 11 PM). Helps identify peak hours and plan resource deployment.
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.hourly_distribution}>
                    <XAxis dataKey="hour" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false}
                      tickFormatter={h => `${h}h`} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Top Locations */}
            {data.locations?.length > 0 && (
              <div className="glass-card" style={{ padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <MapPin size={14} color="var(--success)" /> Hotspot Locations
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.locations} layout="vertical">
                    <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="location" type="category" width={120} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
