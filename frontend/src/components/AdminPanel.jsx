import { useState, useEffect } from 'react';
import { Shield, LogOut, Users, Settings, ChevronDown, Search, X, Eye, EyeOff, LayoutDashboard, Loader } from 'lucide-react';
import { api } from '../utils/api';

export default function AdminPanel({ user, onLogin, onLogout }) {
  const [adminUser, setAdminUser] = useState(user);
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [users, setUsers] = useState([]);
  const [settings, setSettings] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('users');
  const [pendingRoles, setPendingRoles] = useState({});
  const [updatingKeys, setUpdatingKeys] = useState({});

  const isLoggedIn = adminUser && adminUser.role === 'Admin';

  useEffect(() => {
    if (!isLoggedIn) return;
    fetchData();
  }, [isLoggedIn]);

  const fetchData = async () => {
    try { setUsers(await api.getUsers()); } catch (e) { }
    try { setSettings(await api.getSettings()); } catch (e) { }
  };

  const getServiceMode = (serviceKey) => {
    if (settings[`${serviceKey}_mode_all`] !== false && settings[`${serviceKey}_mode_custom`] !== true) {
      return 'all';
    }
    if (settings[`${serviceKey}_mode_custom`] === true) {
      return 'custom';
    }
    return 'none';
  };

  const getMasterKey = (serviceKey) => {
    if (serviceKey === 'chatbot') return 'is_chatbot_active';
    if (serviceKey === 'routing') return 'is_routing_active';
    if (serviceKey === 'overlay') return 'is_traffic_overlay_active';
    if (serviceKey === 'density') return 'is_traffic_density_active';
    return `is_${serviceKey}_active`;
  };

  const getRoleValue = (serviceKey, role) => {
    const val = settings[`${serviceKey}_roles_${role}`];
    if (val === 'on' || val === 'limited' || val === 'off') {
      return val;
    }
    if (val === true || val === 'true' || val === undefined) {
      return 'on';
    }
    return 'off';
  };

  const handleModeChange = async (serviceKey, newMode) => {
    const masterKey = getMasterKey(serviceKey);
    let updatedPayload = {};
    if (newMode === 'all') {
      updatedPayload = {
        [masterKey]: true,
        [`${serviceKey}_mode_all`]: true,
        [`${serviceKey}_mode_custom`]: false,
        [`${serviceKey}_roles_Commuter`]: 'on',
        [`${serviceKey}_roles_Officer`]: 'on',
      };
    } else if (newMode === 'none') {
      updatedPayload = {
        [masterKey]: false,
        [`${serviceKey}_mode_all`]: false,
        [`${serviceKey}_mode_custom`]: false,
        [`${serviceKey}_roles_Commuter`]: 'off',
        [`${serviceKey}_roles_Officer`]: 'off',
      };
    } else if (newMode === 'custom') {
      const commVal = getRoleValue(serviceKey, 'Commuter');
      const offVal = getRoleValue(serviceKey, 'Officer');
      updatedPayload = {
        [masterKey]: true,
        [`${serviceKey}_mode_all`]: false,
        [`${serviceKey}_mode_custom`]: true,
        [`${serviceKey}_roles_Commuter`]: commVal,
        [`${serviceKey}_roles_Officer`]: offVal,
      };
    }

    setUpdatingKeys(prev => ({ ...prev, [serviceKey]: true }));
    try {
      setSettings(await api.updateSettings(updatedPayload));
    } catch (e) {
      alert(e.message);
    } finally {
      setUpdatingKeys(prev => ({ ...prev, [serviceKey]: false }));
    }
  };

  const handleRoleValueChange = async (serviceKey, role, newValue) => {
    const key = `${serviceKey}_roles_${role}`;
    setUpdatingKeys(prev => ({ ...prev, [key]: true }));
    try {
      let payload = { [key]: newValue };
      if (serviceKey === 'verification') {
        payload = {
          ...payload,
          is_verification_active: 'true',
          verification_mode_custom: 'true',
          verification_mode_all: 'false',
          verification_roles_Commuter: 'off',
        };
      }
      setSettings(await api.updateSettings(payload));
    } catch (e) {
      alert(e.message);
    } finally {
      setUpdatingKeys(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleLogin = async () => {
    if (!loginForm.email || !loginForm.password) return;
    setLoginLoading(true);
    setLoginError('');
    try {
      const data = await api.adminLogin(loginForm.email, loginForm.password);
      api.setToken(data.token);
      api.setUser(data.user);
      setAdminUser(data.user);
      if (onLogin) onLogin(data.user);
    } catch (e) {
      setLoginError(e.message || 'Invalid credentials');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleSaveRole = async (userId) => {
    const newRole = pendingRoles[userId];
    if (!newRole) return;
    try {
      await api.updateUserRole(userId, newRole);
      setPendingRoles(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setUsers(await api.getUsers());
    } catch (e) {
      alert(e.message);
    }
  };

  const handleSettingToggle = async (key) => {
    const updated = { ...settings, [key]: !settings[key] };
    setUpdatingKeys(prev => ({ ...prev, [key]: true }));
    try {
      setSettings(await api.updateSettings({ [key]: updated[key] }));
    } catch (e) {
      alert(e.message);
    } finally {
      setUpdatingKeys(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleLogout = () => {
    api.clearToken();
    setAdminUser(null);
    if (onLogout) onLogout();
  };

  const filteredUsers = users.filter(u =>
    !searchQuery || u.name?.toLowerCase().includes(searchQuery.toLowerCase()) || u.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Admin Login ─────────────────────────────────────────────────────────
  if (!isLoggedIn) {
    return (
      <div className="admin-portal" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-card" style={{ width: 400, maxWidth: '90vw', padding: '48px 40px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, letterSpacing: -1 }}>
            <Shield size={28} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 8, color: 'var(--danger)' }} />
            Admin Portal
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 32 }}>Restricted access. Administrators only.</p>
          <div style={{ textAlign: 'left' }}>
            <label className="label">Email</label>
            <input className="input" type="email" value={loginForm.email}
              onChange={e => setLoginForm({ ...loginForm, email: e.target.value })}
              placeholder="admin@gmail.com" style={{ marginBottom: 14 }}
              onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            <label className="label">Password</label>
            <div style={{ position: 'relative' }}>
              <input className="input" type={showPassword ? 'text' : 'password'} value={loginForm.password}
                onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
                placeholder="••••••••" style={{ marginBottom: 14, paddingRight: 40 }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()} />
              <button onClick={() => setShowPassword(!showPassword)}
                style={{ position: 'absolute', right: 10, top: 8, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {loginError && <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 12 }}>{loginError}</p>}
            <button className="btn btn-danger" style={{ width: '100%' }} onClick={handleLogin} disabled={loginLoading}>
              {loginLoading ? 'Authenticating...' : 'Sign In as Admin'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Admin Dashboard ─────────────────────────────────────────────────────
  return (
    <div className="admin-portal">
      <div className="admin-container">
        <div className="admin-header">
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Shield size={24} color="var(--danger)" /> Admin Console
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{adminUser.email}</div>
          </div>
          <div className="admin-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-ghost" onClick={() => window.location.hash = '#/'} title="Dashboard" style={{ padding: 8, minWidth: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius)' }}>
              <LayoutDashboard size={16} />
            </button>
            <button className="btn btn-danger btn-sm" onClick={handleLogout}>
              <LogOut size={14} /> Sign Out
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="admin-tabs-nav">
          {[['users', 'User Management'], ['settings', 'System Settings']].map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`btn ${activeTab === key ? 'btn-primary' : 'btn-ghost'}`}>
              {key === 'users' ? <Users size={14} /> : <Settings size={14} />} {label}
            </button>
          ))}
        </div>

        {/* Users Tab */}
        {activeTab === 'users' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={14} style={{ position: 'absolute', left: 12, top: 12, color: 'var(--text-muted)' }} />
                <input className="input" placeholder="Search users..." value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)} style={{ paddingLeft: 36 }} />
              </div>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{filteredUsers.length} users</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Google ID</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(u => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 500 }}>{u.name || '—'}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                      <td>
                        <span className={`badge ${u.role === 'Admin' ? 'badge-red' : u.role === 'Officer' ? 'badge-purple' : 'badge-blue'}`}>
                          {u.role}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'JetBrains Mono' }}>
                        {u.google_id ? u.google_id.substring(0, 12) + '...' : '—'}
                      </td>
                      <td>
                        {u.role !== 'Admin' && (
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <select className="input" value={pendingRoles[u.id] !== undefined ? pendingRoles[u.id] : u.role}
                              onChange={e => setPendingRoles(prev => ({ ...prev, [u.id]: e.target.value }))}
                              style={{ width: 110, padding: '4px 8px', fontSize: 12 }}>
                              <option value="Commuter">Commuter</option>
                              <option value="Officer">Officer</option>
                            </select>
                            {pendingRoles[u.id] !== undefined && pendingRoles[u.id] !== u.role && (
                              <button className="btn btn-primary btn-sm"
                                onClick={() => handleSaveRole(u.id)}
                                style={{ padding: '4px 10px', fontSize: 11, height: 28, minWidth: 'unset' }}>
                                Save
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>Service Control Panel</div>

            {[
              { key: 'chatbot', label: 'AI Chatbot', desc: 'Enable/disable the AI chat assistant for all users' },
              { key: 'routing', label: 'Route Planning', desc: 'Enable/disable the dual-route calculation service' },
              { key: 'density', label: 'Live Traffic Density Search', desc: 'Enable/disable TomTom live traffic search service globally' },
              { key: 'ai_suggestion', label: 'AI Suggestions', desc: 'Enable/disable AI-generated recommendations for traffic officers' }
            ].map(s => {
              const isVerification = s.key === 'verification';
              const mode = isVerification ? 'custom' : getServiceMode(s.key);

              return (
                <div key={s.key} className="service-control-block">
                  <div className="service-info">
                    <div className="service-label">{s.label}</div>
                    <div className="service-desc">{s.desc}</div>
                  </div>

                  <div className="service-controls-wrapper">
                    {/* Universal Toggle (3-way selector) */}
                    {!isVerification && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div className="segmented-selector">
                          <button
                            className={mode === 'all' ? 'active' : ''}
                            disabled={updatingKeys[s.key]}
                            onClick={() => handleModeChange(s.key, 'all')}
                          >
                            All
                          </button>
                          <button
                            className={mode === 'custom' ? 'active' : ''}
                            disabled={updatingKeys[s.key]}
                            onClick={() => handleModeChange(s.key, 'custom')}
                          >
                            Custom
                          </button>
                          <button
                            className={mode === 'none' ? 'active' : ''}
                            disabled={updatingKeys[s.key]}
                            onClick={() => handleModeChange(s.key, 'none')}
                          >
                            None
                          </button>
                        </div>
                        {updatingKeys[s.key] && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Loader size={10} style={{ animation: 'spin 1s linear infinite' }} /> Saving...
                          </span>
                        )}
                      </div>
                    )}

                    {/* Connected Sub-Toggles */}
                    <div className="role-toggles-row">
                      {!isVerification && (
                        <div className={`role-toggle-item ${mode !== 'custom' ? 'disabled' : ''}`}>
                          <span>Commuter</span>
                          <div className="segmented-selector" style={{ pointerEvents: mode !== 'custom' ? 'none' : 'auto' }}>
                            <button
                              className={getRoleValue(s.key, 'Commuter') === 'on' ? 'active' : ''}
                              disabled={mode !== 'custom' || updatingKeys[`${s.key}_roles_Commuter`]}
                              onClick={() => handleRoleValueChange(s.key, 'Commuter', 'on')}
                              style={{ padding: '4px 10px', fontSize: '10px' }}
                            >
                              On
                            </button>
                            <button
                              className={getRoleValue(s.key, 'Commuter') === 'limited' ? 'active' : ''}
                              disabled={mode !== 'custom' || updatingKeys[`${s.key}_roles_Commuter`]}
                              onClick={() => handleRoleValueChange(s.key, 'Commuter', 'limited')}
                              style={{ padding: '4px 10px', fontSize: '10px' }}
                            >
                              Limited
                            </button>
                            <button
                              className={getRoleValue(s.key, 'Commuter') === 'off' ? 'active' : ''}
                              disabled={mode !== 'custom' || updatingKeys[`${s.key}_roles_Commuter`]}
                              onClick={() => handleRoleValueChange(s.key, 'Commuter', 'off')}
                              style={{ padding: '4px 10px', fontSize: '10px' }}
                            >
                              Off
                            </button>
                          </div>
                          {updatingKeys[`${s.key}_roles_Commuter`] && (
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Loader size={10} style={{ animation: 'spin 1s linear infinite' }} /> Saving...
                            </span>
                          )}
                        </div>
                      )}
                      <div className={`role-toggle-item ${(mode !== 'custom' && !isVerification) ? 'disabled' : ''}`}>
                        <span>Officer</span>
                        <div className="segmented-selector" style={{ pointerEvents: (mode !== 'custom' && !isVerification) ? 'none' : 'auto' }}>
                          <button
                            className={getRoleValue(s.key, 'Officer') === 'on' ? 'active' : ''}
                            disabled={(mode !== 'custom' && !isVerification) || updatingKeys[`${s.key}_roles_Officer`]}
                            onClick={() => handleRoleValueChange(s.key, 'Officer', 'on')}
                            style={{ padding: '4px 10px', fontSize: '10px' }}
                          >
                            On
                          </button>
                          <button
                            className={getRoleValue(s.key, 'Officer') === 'limited' ? 'active' : ''}
                            disabled={(mode !== 'custom' && !isVerification) || updatingKeys[`${s.key}_roles_Officer`]}
                            onClick={() => handleRoleValueChange(s.key, 'Officer', 'limited')}
                            style={{ padding: '4px 10px', fontSize: '10px' }}
                          >
                            Limited
                          </button>
                          <button
                            className={getRoleValue(s.key, 'Officer') === 'off' ? 'active' : ''}
                            disabled={(mode !== 'custom' && !isVerification) || updatingKeys[`${s.key}_roles_Officer`]}
                            onClick={() => handleRoleValueChange(s.key, 'Officer', 'off')}
                            style={{ padding: '4px 10px', fontSize: '10px' }}
                          >
                            Off
                          </button>
                        </div>
                        {updatingKeys[`${s.key}_roles_Officer`] && (
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Loader size={10} style={{ animation: 'spin 1s linear infinite' }} /> Saving...
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
