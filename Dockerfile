# Use a base Python image
FROM python:3.9

# Set the working directory
WORKDIR /app

# Copy your project files
COPY requirements.txt .
COPY lambda_function.py .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Expose port 80 (for API Gateway integration)
EXPOSE 80

# Run the application
CMD ["python", "-m", "http.server", "80"]