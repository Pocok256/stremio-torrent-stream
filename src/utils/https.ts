import axios from "axios";
import { RequestListener } from "http";
import https from "https";
import localtunnel from "localtunnel";

enum HttpsMethod {
  None = "none",
  LocalIpMedic = "local-ip.medicmobile.org",
  LocalIpCo = "local-ip.co",
  Localtunnel = "localtunnel",
}

const HTTPS_METHOD = process.env.HTTPS_METHOD || HttpsMethod.None;

const listen = (server: https.Server, port: number) =>
  new Promise<https.Server>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });

export const serveHTTPS = async (app: RequestListener, port: number) => {
  if (HTTPS_METHOD === HttpsMethod.LocalIpMedic) {
    const json = (await axios.get("https://local-ip.medicmobile.org/keys"))
      .data;
    const cert = `${json.cert}\n${json.chain}`;
    const httpsServer = https.createServer({ key: json.privkey, cert }, app);
    await listen(httpsServer, port);
    console.log(`HTTPS addon listening on port ${port}`);
    return httpsServer;
  }

  if (HTTPS_METHOD === HttpsMethod.LocalIpCo) {
    const key = (await axios.get("http://local-ip.co/cert/server.key")).data;
    const serverPem = (await axios.get("http://local-ip.co/cert/server.pem"))
      .data;
    const chainPem = (await axios.get("http://local-ip.co/cert/chain.pem"))
      .data;
    const cert = `${serverPem}\n${chainPem}`;
    const httpsServer = https.createServer({ key, cert }, app);
    await listen(httpsServer, port);
    console.log(`HTTPS addon listening on port ${port}`);
    return httpsServer;
  }

  if (HTTPS_METHOD === HttpsMethod.Localtunnel) {
    const tunnel = await localtunnel({ port: Number(process.env.PORT) });
    console.log(`Tunnel accessible at: ${tunnel.url}`);
    const tunnelPassword = await axios.get("https://loca.lt/mytunnelpassword");
    console.log(`Tunnel password: ${tunnelPassword.data}`);
  }
};
