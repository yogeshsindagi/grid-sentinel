import { useState, useEffect } from 'react';
import { X, Clock, MapPin, AlertTriangle, TrendingUp, Calendar, Package, BarChart3, PieChart as PieIcon } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, ResponsiveContainer, Legend } from 'recharts';
import { api } from '../utils/api';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e', '#06b6d4', '#ef4444', '#f97316'];

export default function HistoricalAnalyticsDashboard({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHistoricalAnalytics();
  }, []);

  const fetchHistoricalAnalytics = async () => {
    try {
      const d = await api.getHistoricalAnalytics();
      setData(d);
    } catch (e) {
      console.error('Historical analytics fetch failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const customTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)',
        boxShadow: 'var(--shadow-sm)'
      }}>
        {label && <div style={{ marginBottom: 4, fontWeight: 600 }}>{label}</div>}
        {payload.map((p, i) => (
          <div key={i}>
            <span style={{ color: p.color || 'var(--accent)' }}>●</span> {p.name || p.dataKey}: <strong>{p.value}</strong>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="drawer-header">
        <div className="drawer-title">
          <Calendar size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
          Historical Analytics
        </div>
        <button className="drawer-close" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="drawer-body">
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>Loading historical data...</div>
        ) : !data ? (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>No historical data available</div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="stats-grid">
              <div className="glass-card stat-card">
                <div className="stat-value">{data.summary?.total_events?.toLocaleString() || 0}</div>
                <div className="stat-label">Total Events</div>
              </div>
              <div className="glass-card stat-card">
                <div className="stat-value" style={{ color: 'var(--accent)' }}>{data.summary?.avg_events_per_month || 0}</div>
                <div className="stat-label">Avg/Month</div>
              </div>
              <div className="glass-card stat-card">
                <div className="stat-value" style={{ color: 'var(--warning)' }}>{data.summary?.avg_resolution_mins || 0} min</div>
                <div className="stat-label">Avg Resolution</div>
              </div>
              <div className="glass-card stat-card">
                <div className="stat-value" style={{ color: 'var(--success)' }}>
                  {data.summary?.closed_events?.toLocaleString() || 0}
                  <span style={{ fontSize: '0.6em', marginLeft: 4, color: 'var(--text-muted)' }}>
                    ({data.summary?.closure_rate_percent || 0}%)
                  </span>
                </div>
                <div className="stat-label">Closed Events</div>
              </div>
            </div>

            {/* Key Insights */}
            <div className="glass-card" style={{ padding: 16, marginBottom: 16, background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(139, 92, 246, 0.1))' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>
                📊 Key Insights
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <div>📅 Data Range: <strong>{data.summary?.date_range?.start}</strong> to <strong>{data.summary?.date_range?.end}</strong></div>
                <div>🚨 Most Common Cause: <strong>{data.summary?.most_common_cause}</strong></div>
                <div>🛣️ Most Problematic Corridor: <strong>{data.summary?.most_problematic_corridor}</strong></div>
              </div>
            </div>

            {/* Monthly Trend */}
            {data.monthly_trend?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <TrendingUp size={14} color="var(--accent)" /> Monthly Trend
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Long-term event frequency pattern over time. Identify seasonal trends and growth patterns.
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={data.monthly_trend}>
                    <XAxis 
                      dataKey="month" 
                      tick={{ fill: '#94a3b8', fontSize: 10 }} 
                      axisLine={false} 
                      tickLine={false} 
                      angle={-45}
                      textAnchor="end"
                      height={70}
                      interval={0}
                    />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={customTooltip} />
                    <Line type="monotone" dataKey="count" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} name="Events" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Event Causes */}
            {data.causes?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} color="var(--warning)" /> Historical Event Causes
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  All-time distribution of incident types. Shows which events are most common historically.
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie 
                      data={data.causes.slice(0, 8).map(c => ({ name: (c.cause || 'unknown').replace(/_/g, ' '), value: c.count }))}
                      cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={3} dataKey="value">
                      {data.causes.slice(0, 8).map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={customTooltip} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                  {data.causes.slice(0, 8).map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
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
                  <Clock size={14} color="var(--accent)" /> Historical Hourly Pattern
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Shows when incidents historically occur throughout the day (24-hour clock). Identifies chronic peak hours.
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.hourly_distribution}>
                    <XAxis dataKey="hour" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false}
                      tickFormatter={h => `${h}h`} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} name="Events" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 🔥 LOCATION HOTSPOTS SECTION */}
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 24, marginBottom: 12, color: 'var(--text-primary)', borderBottom: '2px solid var(--border)', paddingBottom: 8 }}>
              📍 Location Hotspots Analysis
            </div>

            {/* Chronic Problem Areas */}
            {data.locations?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <MapPin size={14} color="var(--danger)" /> Chronic Problem Areas
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Locations with highest recurring incidents. Priority areas for infrastructure improvements.
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={data.locations.slice(0, 12)} layout="vertical">
                    <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="location" type="category" width={140} tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#ef4444" radius={[0, 4, 4, 0]} name="Incidents" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Corridor Analysis */}
            {data.corridors?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <BarChart3 size={14} color="var(--warning)" /> Corridor Analysis
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Which major corridors experience the most incidents. Guides strategic patrol deployment.
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={data.corridors.slice(0, 10)} layout="vertical">
                    <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="corridor" type="category" width={130} tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#f59e0b" radius={[0, 4, 4, 0]} name="Incidents" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Zone Distribution */}
            {data.zones?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PieIcon size={14} color="var(--success)" /> Zone-wise Distribution
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Incident distribution across North, South, East, and West zones of the city.
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={data.zones} layout="vertical">
                    <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="zone" type="category" width={130} tick={{ fill: '#94a3b8', fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#22c55e" radius={[0, 4, 4, 0]} name="Incidents" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Vehicle Type Breakdown */}
            {data.vehicles?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Package size={14} color="var(--accent)" /> Vehicle Type Breakdown
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Which vehicle types are involved in the most incidents. Helps identify maintenance patterns.
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.vehicles.slice(0, 8)}>
                    <XAxis 
                      dataKey="vehicle_type" 
                      tick={{ fill: '#94a3b8', fontSize: 10 }} 
                      axisLine={false} 
                      tickLine={false} 
                      angle={-45} 
                      textAnchor="end" 
                      height={80}
                      interval={0}
                    />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#06b6d4" radius={[4, 4, 0, 0]} name="Incidents" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Priority Distribution */}
            {data.priorities?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} color="var(--danger)" /> Priority Distribution
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Historical breakdown of high vs low priority incidents.
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.priorities}>
                    <XAxis dataKey="priority" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#ec4899" radius={[4, 4, 0, 0]} name="Events" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Event Type Distribution */}
            {data.event_types?.length > 0 && (
              <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Calendar size={14} color="var(--success)" /> Planned vs Unplanned Events
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Ratio of scheduled events (construction, public events) vs spontaneous incidents.
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.event_types}>
                    <XAxis 
                      dataKey="type" 
                      tick={{ fill: '#94a3b8', fontSize: 11 }} 
                      axisLine={false} 
                      tickLine={false}
                      tickFormatter={(value) => value.charAt(0).toUpperCase() + value.slice(1)}
                    />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#22c55e" radius={[4, 4, 0, 0]} name="Events" />
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 8, fontSize: 11 }}>
                  {data.event_types.map((e, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: '#22c55e' }} />
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                        {e.type.charAt(0).toUpperCase() + e.type.slice(1)}: <strong>{e.count.toLocaleString()}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Status Distribution */}
            {data.statuses?.length > 0 && (
              <div className="glass-card" style={{ padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <BarChart3 size={14} color="var(--text-primary)" /> Status Distribution
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
                  Historical event resolution status breakdown.
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.statuses}>
                    <XAxis dataKey="status" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="count" fill="#22c55e" radius={[4, 4, 0, 0]} name="Events" />
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
