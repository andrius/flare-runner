# Tiny image the demo builds with buildah (no Docker daemon) to prove the
# no-DinD image-build path works on a Cloudflare Container runner.
FROM python:3.13-slim
WORKDIR /app
COPY app.py .
EXPOSE 8080
CMD ["python", "app.py"]
