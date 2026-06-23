# Use the official Nginx image from the Docker Hub
FROM nginx:alpine

# Create static file server config
RUN echo 'server { \
    listen 80; \
    server_name localhost; \
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
COPY robots.txt /usr/share/nginx/html/ 
COPY sitemap.xml /usr/share/nginx/html/ 
# Expose port 80
EXPOSE 80

# Optional: Keep Nginx running in the foreground
CMD ["nginx", "-g", "daemon off;"]