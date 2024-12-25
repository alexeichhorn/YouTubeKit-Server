FROM python:3.10-slim

# Install dependencies
COPY requirements.txt .
RUN pip install -r requirements.txt

WORKDIR /app
COPY . /app

EXPOSE 8080

# Run with gunicorn directly using the config file
CMD ["gunicorn", "server:app", "-c", "production_server.py"]