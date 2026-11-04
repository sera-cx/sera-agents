# Use the official Nginx image from the Docker Hub
FROM nginx:alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606

# Create static file server config
RUN echo 'server { \
    listen 80; \
    server_name localhost; \
    server_tokens off; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Copy the index.html file to the Nginx HTML directory
COPY index.html /usr/share/nginx/html/index.html

# Copy the docs directory if it exists and has content
COPY docs /usr/share/nginx/html/docs/

# Copy other static assets if needed
COPY favicon-32.png /usr/share/nginx/html/ 
COPY favicon-512.png /usr/share/nginx/html/ 
COPY logo.png /usr/share/nginx/html/ 
# Compiled CSS (npm run build:css), per-page CSS, and the landing page's JS.
# These are same-origin so the CSP needs no 'unsafe-inline' and no CDN origin.
COPY assets /usr/share/nginx/html/assets/
COPY robots.txt /usr/share/nginx/html/
COPY sitemap.xml /usr/share/nginx/html/
# Discovery manifests: agent card + MCP catalog served at /.well-known/*
COPY .well-known /usr/share/nginx/html/.well-known/
# Expose port 80
EXPOSE 80

# Optional: Keep Nginx running in the foreground
CMD ["nginx", "-g", "daemon off;"]