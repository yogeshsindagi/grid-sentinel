import os
import datetime
import time
import random
from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, DateTime, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from config import DATABASE_URL

db_url = DATABASE_URL
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

is_sqlite = db_url.startswith("sqlite")

# Configure appropriate engine flags depending on database type
if is_sqlite:
    engine = create_engine(
        db_url, 
        connect_args={"check_same_thread": False}
    )
else:
    engine = create_engine(db_url)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def generate_custom_id(prefix: str) -> str:
    millis = int(time.time() * 1000)
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    base36 = ""
    val = millis
    while val > 0:
        val, remainder = divmod(val, 36)
        base36 = chars[remainder] + base36
    suffix = "".join(random.choices(chars, k=6))
    return f"{prefix}-{base36}-{suffix}"

class User(Base):
    __tablename__ = "users"
    id = Column(String(50), primary_key=True, index=True, default=lambda: generate_custom_id("USR"))
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=True)
    role = Column(String, default="Commuter")  # Commuter, Officer, Admin
    is_authorized = Column(Boolean, default=False)
    google_id = Column(String, unique=True, nullable=True, index=True)
    profile_picture = Column(String, nullable=True)

class Report(Base):
    __tablename__ = "reports"
    id = Column(String(50), primary_key=True, index=True, default=lambda: generate_custom_id("REP"))
    user_id = Column(String(50), nullable=True)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    address = Column(String, nullable=True)
    event_cause = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    status = Column(String, default="pending")  # pending, verified, rejected
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Event(Base):
    __tablename__ = "events"
    id = Column(String(50), primary_key=True, index=True, default=lambda: generate_custom_id("EVT"))
    creator_id = Column(String(50), nullable=True)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    address = Column(String, nullable=True)
    event_cause = Column(String, nullable=True)
    requires_road_closure = Column(Boolean, default=False)
    zone_type = Column(String, nullable=True)  # Red (closure), Yellow (no closure)
    priority = Column(String, nullable=True)  # High, Medium, Low
    veh_type = Column(String, nullable=True)
    start_datetime = Column(DateTime, default=datetime.datetime.utcnow)
    initial_clearance_time_mins = Column(Integer, default=60)
    current_clearance_time_mins = Column(Integer, default=60)
    status = Column(String, default="active")  # active, resolved
    resolved_at = Column(DateTime, nullable=True)
    description = Column(Text, nullable=True)
    corridor = Column(String, nullable=True)  # e.g. Mysore Road, ORR North 1, Non-corridor
    endlatitude = Column(Float, nullable=True)  # End-point latitude (for road closure segments)
    endlongitude = Column(Float, nullable=True)  # End-point longitude (for road closure segments)
    
    # AI Cache fields (calculated once and saved)
    officer_suggestions = Column(Text, nullable=True)  # JSON string containing police instructions
    traveler_suggestions = Column(Text, nullable=True)  # JSON string containing traveler instructions
    detour_route_geojson = Column(Text, nullable=True)  # JSON string containing detour route details

class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(String)

def init_db():
    if is_sqlite:
        # Enable Write-Ahead Logging for concurrency mitigation
        from sqlalchemy import text
        with engine.begin() as connection:
            connection.execute(text("PRAGMA journal_mode=WAL;"))
    Base.metadata.create_all(bind=engine)
    
    # Auto-migration: add any missing columns to existing tables
    from sqlalchemy import text
    try:
        with engine.begin() as connection:
            if is_sqlite:
                cursor = connection.execute(text("PRAGMA table_info(events)"))
                columns = [row[1] for row in cursor.fetchall()]
                # Migrate resolved_time -> resolved_at
                if 'resolved_time' in columns:
                    connection.execute(text("UPDATE events SET resolved_at = resolved_time WHERE resolved_at IS NULL AND resolved_time IS NOT NULL;"))
                    try:
                        connection.execute(text("ALTER TABLE events DROP COLUMN resolved_time;"))
                    except Exception:
                        pass
                # Add new columns if missing
                new_columns = {
                    'description': 'TEXT',
                    'corridor': 'VARCHAR',
                    'endlatitude': 'FLOAT',
                    'endlongitude': 'FLOAT'
                }
                for col_name, col_type in new_columns.items():
                    if col_name not in columns:
                        try:
                            connection.execute(text(f"ALTER TABLE events ADD COLUMN {col_name} {col_type};"))
                        except Exception:
                            pass
            else:
                # PostgreSQL
                cursor = connection.execute(text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'events';"
                ))
                columns = [row[0] for row in cursor.fetchall()]
                if 'resolved_time' in columns:
                    connection.execute(text("UPDATE events SET resolved_at = resolved_time WHERE resolved_at IS NULL AND resolved_time IS NOT NULL;"))
                    connection.execute(text("ALTER TABLE events DROP COLUMN resolved_time;"))
                new_columns = {
                    'description': 'TEXT',
                    'corridor': 'VARCHAR',
                    'endlatitude': 'FLOAT',
                    'endlongitude': 'FLOAT'
                }
                for col_name, col_type in new_columns.items():
                    if col_name not in columns:
                        try:
                            connection.execute(text(f"ALTER TABLE events ADD COLUMN {col_name} {col_type};"))
                        except Exception:
                            pass
    except Exception as e:
        print(f"Migration/Cleanup warning: {e}")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
