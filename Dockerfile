FROM python:3.10-alpine3.18

# Install dependencies
ADD requirements.txt .
RUN pip install -r requirements.txt

ADD . /app

WORKDIR /app

EXPOSE 8080

CMD ["python", "production_server.py"]