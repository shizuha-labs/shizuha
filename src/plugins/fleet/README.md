# Fleet plugin (`fleet/k8s`)

Hive/k3s actuator. Same tree as the public product. It is **mounted**
only on the `fleet` profile (DeepSeek-style composition: one source,
different boot rows).

| Profile | How you get it | `fleet/k8s` |
|---|---|---|
| `default` | local `shizuha` / `shizuha up` | not mounted |
| `fleet` | `SHIZUHA_PROFILE=fleet`, or a k8s fleet daemon (`SHIZUHA_DAEMON_RUNTIME=k8s` / `SHIZUHA_FLEET_NAMESPACE`) | mounted |

`shizuha plugins` prints the composed tree. `build:public --no-fleet-plugin`
can still alias the stub at bundle time; it is optional. The source stays.

Callers keep importing `src/daemon/k8s-backend.ts`.
