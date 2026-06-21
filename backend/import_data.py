"""
backend/import_data.py
Database initialization and seeding script.
Creates tables, admin user, and default settings on first run.
"""

import os
from sqlalchemy.orm import Session
from database import init_db, SessionLocal, User, Setting
from config import ADMIN_USERNAME, ADMIN_PASSWORD


def import_all():
    print("Initializing Database...")
    init_db()
    
    db = SessionLocal()
    try:
        # Check if admin user already exists
        if db.query(User).filter(User.role == "Admin").count() > 0:
            print("✅ Database already populated. Skipping seed.")
            return
            
        print("Creating admin account...")
        admin = User(
            email=ADMIN_USERNAME,
            name="System Admin",
            role="Admin",
            is_authorized=True,
            google_id=None,
            profile_picture=None
        )
        db.add(admin)
        db.commit()
        
        # Add default service settings
        print("Configuring default service settings...")
        settings_defaults = {
            "is_chatbot_active": "true",
            "is_routing_active": "true",
            "is_traffic_overlay_active": "true"
        }
        for k, v in settings_defaults.items():
            existing = db.query(Setting).filter(Setting.key == k).first()
            if not existing:
                db.add(Setting(key=k, value=v))
        db.commit()
        print("✅ Database seeding complete.")
    except Exception as e:
        db.rollback()
        print(f"⚠️ Seeding error (may already exist): {e}")
    finally:
        db.close()

if __name__ == "__main__":
    import_all()
