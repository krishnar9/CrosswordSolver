import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    def __init__(self):
        raw_emails = os.getenv("ALLOWED_EMAILS", "")
        self.allowed_emails: list[str] = [e.strip() for e in raw_emails.split(",") if e.strip()]

        self.google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
        self.google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")

        self.session_retention_days: int = int(os.getenv("SESSION_RETENTION_DAYS", "30"))
        self.autosave_interval_seconds: int = int(os.getenv("AUTOSAVE_INTERVAL_SECONDS", "120"))

        self.ollama_endpoint: str = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434")
        self.ollama_model: str = os.getenv("OLLAMA_MODEL", "")

        self.upload_dir: str = os.getenv("UPLOAD_DIR", "./uploads")
        self.database_path: str = os.getenv("DATABASE_PATH", "./data/puzzle.db")

        self.secret_key: str = os.getenv("SECRET_KEY", "")

    def validate(self) -> list[str]:
        """Return a list of missing required variable names."""
        missing = []
        if not self.allowed_emails:
            missing.append("ALLOWED_EMAILS")
        if not self.google_client_id:
            missing.append("GOOGLE_CLIENT_ID")
        if not self.google_client_secret:
            missing.append("GOOGLE_CLIENT_SECRET")
        if not self.ollama_model:
            missing.append("OLLAMA_MODEL")
        if not self.secret_key:
            missing.append("SECRET_KEY")
        return missing


settings = Settings()
