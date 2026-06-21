import sys
import os

# Add parent directory to path to import backend modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.database import SessionLocal, Event, Report

def clear_db():
    db = SessionLocal()
    try:
        print("Clearing events table...")
        num_events = db.query(Event).delete()
        print(f"Cleared {num_events} events.")

        print("Clearing reports table...")
        num_reports = db.query(Report).delete()
        print(f"Cleared {num_reports} reports.")

        db.commit()
        print("Database cleared successfully (events and reports wiped).")
    except Exception as e:
        db.rollback()
        print(f"Error wiping database: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    clear_db()
