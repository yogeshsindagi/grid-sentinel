import React from 'react';

export default function LoadingSpinner({ message = "Loading...", size = 32 }) {
  return (
    <div className="spinner-overlay">
      <div className="spinner-ring-container" style={{ width: size, height: size }}>
        <div 
          className="spinner-ring-outer" 
          style={{ width: size, height: size }} 
        />
        <div 
          className="spinner-ring-inner" 
          style={{ width: size, height: size }} 
        />
      </div>
      {message && <span className="spinner-msg">{message}</span>}
    </div>
  );
}
