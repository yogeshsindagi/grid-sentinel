import os
import re

# Load .env or env.txt into environment variables (only locally; Azure uses App Settings)
env_path = os.path.join(os.path.dirname(__file__), ".env")
if not os.path.exists(env_path):
    env_path = os.path.join(os.path.dirname(__file__), "env.txt")

if os.path.exists(env_path):
    with open(env_path, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip("'\"")
                if val:
                    os.environ[key] = val

AZURE_ENDPOINT = os.environ.get(
    "AZURE_EXISTING_AIPROJECT_ENDPOINT",
    "https://experiment-1-resource.services.ai.azure.com/api/projects/experiment_1"
)
AZURE_AGENT_ID = os.environ.get("AZURE_EXISTING_AGENT_ID", "Hacker:2")
AZURE_API_KEY = os.environ.get("AZURE_API_KEY", "")

# DATABASE_URL — on Azure, set this to your PostgreSQL or keep sqlite for F1 free
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./gridlock_sentinel.db")

# System Administrator credentials
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin@gmail.com")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

# JWT & Google OAuth Credentials
JWT_SECRET = os.environ.get("JWT_SECRET", "supersecretkey123")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")

# TomTom Traffic API
TOMTOM_API_KEY = os.environ.get("TOMTOM_API_KEY", "")

# CORS — set FRONTEND_URL in Azure App Settings to your Vercel URL
# e.g.  FRONTEND_URL=https://grid-locked.vercel.app
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")

# Load Azure Subscription, Resource Group, and Project details
AZURE_SUBSCRIPTION_ID = os.environ.get("AZURE_SUBSCRIPTION_ID")
AZURE_RESOURCE_GROUP = os.environ.get("AZURE_RESOURCE_GROUP_NAME") or os.environ.get("AZURE_RESOURCE_GROUP")
AZURE_PROJECT_NAME = os.environ.get("AZURE_PROJECT_NAME")

# Try to parse from Azure Resource ID if available
resource_id = os.environ.get("AZURE_EXISTING_AIPROJECT_RESOURCE_ID")
if resource_id:
    m = re.search(
        r'subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\.MachineLearningServices/workspaces/([^/]+)',
        resource_id, re.IGNORECASE
    )
    if m:
        if not AZURE_SUBSCRIPTION_ID:
            AZURE_SUBSCRIPTION_ID = m.group(1)
        if not AZURE_RESOURCE_GROUP:
            AZURE_RESOURCE_GROUP = m.group(2)
        if not AZURE_PROJECT_NAME:
            AZURE_PROJECT_NAME = m.group(3)

# Fallback project name parsing from endpoint
if not AZURE_PROJECT_NAME and AZURE_ENDPOINT:
    m = re.search(r'/api/projects/([^/]+)', AZURE_ENDPOINT, re.IGNORECASE)
    if m:
        AZURE_PROJECT_NAME = m.group(1)
