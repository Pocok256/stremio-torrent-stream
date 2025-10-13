# Stremio Torrent Stream

This self-hostable addon enables [Stremio](https://www.stremio.com/) to stream movies and shows from torrents. Works with both public and private trackers through [Jackett](https://github.com/Jackett/Jackett) and built-in scrapers. It uses [WebTorrent](https://github.com/webtorrent/webtorrent) under the hood.

![image](https://github.com/nyakaspeter/stremio-torrent-stream/assets/43880678/42040b81-2bf5-43f0-b827-9d62c3a1d79c)

## How to run

With Docker:
```
docker run -p 58827:58827 -p 58828:58828 nyakaspeter/stremio-torrent-stream
```

With Docker Compose (the addon and Jackett simultaneously):
```
git clone https://github.com/nyakaspeter/stremio-torrent-stream.git
cd stremio-torrent-stream
docker compose up
```

With Node.js and [pnpm](https://pnpm.io/installation):
```
git clone https://github.com/nyakaspeter/stremio-torrent-stream.git
cd stremio-torrent-stream
pnpm i
pnpm build
pnpm start
```

Once the addon server is up, you'll see a console output like this:
```
HTTP addon listening on port 58827
HTTPS addon listening on port 58828
```

On your local computer you can install the addon from http://localhost:58827 but if you want to use it with other devices you'll have install it from an HTTPS enabled address. I've bundled a wildcard certificate from [local-ip](https://local-ip.medicmobile.org/) with the server, which will provide valid HTTPS for your local IPs. To find out the HTTPS address of the addon take the LAN IP of the host and replace dots with hyphens, then append **.local-ip.medicmobile.org and the HTTPS port at the end**. Let's say the LAN IP of your machine hosting the addon on port **58828** is **192.168.0.10**, in this case you can install the addon from https://192-168-0-10.local-ip.medicmobile.org:58828.

If the above doesn't work for you, you can try opening an HTTPS tunnel to the addon server with [localtunnel](https://theboroer.github.io/localtunnel-www/). To do this set the environment variable `HTTPS_METHOD=localtunnel`. After you start the addon server you'll see this in the console:
```
Tunnel accessible at: https://some-random-domain.loca.lt
Tunnel password: x.xxx.xxx.xx
```

When you first open the localtunnel URL it will ask for a password, you can copy it from the console output. After submitting the password the browser will show the configuration screen for the addon.

## Configuring the addon

On the configuration screen you can set up your torrent site & Jackett credentials (they're optional) and configure torrent search settings.

![image](https://github.com/nyakaspeter/stremio-torrent-stream/assets/43880678/d9a581a9-8036-44ab-942a-3750261cb50c)

When you're done with the configuration hit the install button at the bottom, that will redirect you to Stremio where you can finally install the addon. If you've configured everything properly you'll see torrent results populating the stream list for movies and shows. Enjoy streaming!

## Error Tracking with Sentry

The addon supports error tracking with [Sentry](https://sentry.io/) to help monitor and debug issues in production.

### Setting up Sentry

1. Create a free account at [sentry.io](https://sentry.io/)
2. Create a new Node.js project
3. Copy your DSN (Data Source Name) from the project settings
4. Set the `SENTRY_DSN` environment variable:

**With Docker:**
```bash
docker run -p 58827:58827 -p 58828:58828 \
  -e SENTRY_DSN="https://your-key@sentry.io/your-project-id" \
  nyakaspeter/stremio-torrent-stream
```

**With Docker Compose:**
Edit `compose.yaml` and uncomment the SENTRY_DSN line:
```yaml
environment:
  - SENTRY_DSN=https://your-key@sentry.io/your-project-id
```

**With Node.js:**
Create a `.env` file in the project root:
```
SENTRY_DSN=https://your-key@sentry.io/your-project-id
```

If `SENTRY_DSN` is not set, the addon will run normally without error tracking.

