import asyncio
import re

import ollama

from app.config import settings

NUM_SUGGESTIONS = 4


class OllamaClient:
    def __init__(self):
        self.model: str | None = None

    def _headers(self) -> dict:
        if settings.ollama_cf_client_id and settings.ollama_cf_client_secret:
            return {
                "CF-Access-Client-Id": settings.ollama_cf_client_id,
                "CF-Access-Client-Secret": settings.ollama_cf_client_secret,
            }
        return {}

    def load_model(self):
        """Verify the configured model is registered in the Ollama instance.
        Register once with: ollama create <MODEL_NAME> -f Modelfile"""
        sync_client = ollama.Client(host=settings.ollama_endpoint, headers=self._headers())
        available = [m.model for m in sync_client.list().models]
        if settings.ollama_model not in available:
            raise RuntimeError(
                f"Model '{settings.ollama_model}' not found in Ollama registry.\n"
                f"Register it first with:\n"
                f"  ollama create {settings.ollama_model} -f Modelfile"
            )
        self.model = settings.ollama_model

    async def predict(self, clue: str, template: str, length: int) -> list[str]:
        """Fire NUM_SUGGESTIONS requests concurrently and return unique valid answers.

        template uses '-' for unknown cells (e.g. 'W--D' for a 4-letter answer with
        first=W and last=D). Returns fewer than NUM_SUGGESTIONS items if the model
        produces repeats or unparseable output — caller renders empty slots as greyed out.
        """
        query = f"Answer the crossword clue in exactly {length} letters: {clue} ({template})"
        client = ollama.AsyncClient(host=settings.ollama_endpoint, headers=self._headers())

        tasks = [
            client.generate(
                model=self.model,
                prompt=query,
                options={
                    "temperature": settings.ollama_temperature + i * 0.1,
                    "num_predict": settings.ollama_num_predict,
                    "top_k": settings.ollama_top_k,
                    "top_p": settings.ollama_top_p,
                    "repeat_penalty": settings.ollama_repeat_penalty,
                },
            )
            for i in range(NUM_SUGGESTIONS)
        ]
        results = await asyncio.gather(*tasks)

        seen: set[str] = set()
        suggestions: list[str] = []
        for r in results:
            # Strip to alpha only, uppercase, pad to length with '_' if short
            cleaned = re.sub(r"[^A-Za-z]", "", r.response.strip()).upper()
            padded = cleaned[:length].ljust(length, "_")
            if set(padded) == {"_"}:
                continue
            if padded not in seen:
                seen.add(padded)
                suggestions.append(padded)

        return suggestions


client = OllamaClient()
