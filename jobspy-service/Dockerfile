FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for web scraping
# - chromium/chromium-driver for JobSpy
# - firefox-esr for Camoufox (Google Jobs scraping)
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    firefox-esr \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome options for headless
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMEDRIVER_PATH=/usr/bin/chromedriver

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download Camoufox browser (required for Google Jobs scraping)
RUN python -m camoufox fetch || true

# Copy application
COPY main.py proxy_pool.py google_scraper.py ./

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
