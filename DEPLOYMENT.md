# Deploying Line / Value with Docker

The application has no server-side database. Its bundled recipe data is built
into the image, while imported data, NPC payouts, skill levels, and display
preferences remain in each visitor's browser storage.

## Fastest deployment

Install Docker Engine with the Docker Compose plugin on the server, copy this
project to the server, and run from the project directory:

```bash
docker compose up -d --build
```

Open `http://SERVER_IP:3000` after the container becomes healthy.

Check its status and logs with:

```bash
docker compose ps
docker compose logs -f line-value
```

## Updating the application

Copy or pull the updated project files, then rebuild in place:

```bash
docker compose up -d --build
```

Docker replaces the old container. Browser-stored calculator settings are not
inside the container and are therefore unaffected. Shared pricing save files
live in the persistent `seed-eco-data` Docker volume and also survive rebuilds.

## Backing up shared pricing saves

The application stores its SQLite database in `/app/data` inside the named
Docker volume. To create a consistent backup from the project directory:

```bash
docker compose stop line-value
docker run --rm \
  -v seed-eco-analyser_seed-eco-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/seed-eco-data-backup.tgz -C /data .
docker compose start line-value
```

To restore that backup, stop the service, clear the dedicated volume contents,
extract the archive, and restart the service:

```bash
docker compose stop line-value
docker run --rm \
  -v seed-eco-analyser_seed-eco-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'rm -f /data/* && tar xzf /backup/seed-eco-data-backup.tgz -C /data'
docker compose start line-value
```

The volume prefix follows `COMPOSE_PROJECT_NAME`; the supplied Jenkins pipeline
uses `seed-eco-analyser`.

## Using a domain and HTTPS

Keep port 3000 private and place an existing reverse proxy in front of it. For
example, a minimal Caddy configuration is:

```caddyfile
calculator.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

After DNS points the domain to the server, Caddy obtains and renews HTTPS
certificates automatically. If the reverse proxy itself runs in Docker, proxy
to `line-value:3000` from a shared Docker network instead of `127.0.0.1`.

## Changing the public port

Change only the left side of the port mapping in `compose.yaml`:

```yaml
ports:
  - "8080:3000"
```

The application then opens at `http://SERVER_IP:8080`.

## Automatic deployment with Jenkins

The repository includes a `Jenkinsfile` for a Jenkins agent running on the
same Ubuntu server as Docker. Every triggered pipeline:

1. checks out the requested Git commit;
2. builds the Docker image, running lint, tests, and the production build;
3. replaces the running Compose service only after the image succeeds; and
4. waits for the container health check before marking the deployment green.

Create a Jenkins **Pipeline** or **Multibranch Pipeline** for this repository
and select **Pipeline script from SCM** with `Jenkinsfile` as the script path.
Set the branch specifier to `*/main`. The pipeline polls that configured branch
once every minute and starts a build only when its Git revision changes, so a
GitHub webhook is optional. Give the Jenkins user access to Docker. The server
needs Docker Engine and the Docker Compose plugin; Node.js is not required on
the Jenkins host.

If a deployment fails, Jenkins prints the current service status and the last
150 application log lines. The previously running container is not replaced
when the image build or tests fail.
