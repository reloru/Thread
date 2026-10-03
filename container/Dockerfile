FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg PIP_NO_CACHE_DIR=1
# An optional proxy CA (only behind a TLS-inspecting proxy) is mounted for this step and not kept in the image.
RUN --mount=type=secret,id=proxy_ca,required=false \
	if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi \
	&& pip install numpy pandas matplotlib scipy sympy pillow \
	&& useradd --create-home --uid 1000 sandbox \
	&& mkdir /workspace && chown sandbox /workspace
COPY runner.py kernel.py /app/
USER sandbox
WORKDIR /workspace
EXPOSE 8080
CMD ["python", "/app/runner.py"]
