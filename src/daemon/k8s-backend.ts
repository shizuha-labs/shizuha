/**
 * Fleet k8s actuator entry.
 *
 * Always the same source as public. The `fleet` profile mounts the real
 * actuator; `default` leaves it unmounted (`isK8sAgent` is false).
 * `build:public --no-fleet-plugin` may also alias the stub at bundle time.
 *
 * Callers keep importing `./k8s-backend.js`.
 */
export * from '../plugins/fleet/k8s-backend.js';
