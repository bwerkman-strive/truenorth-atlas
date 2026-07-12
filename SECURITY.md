# Security Policy

True North Atlas handles no user funds and no private keys, but it does run a
public API, an email platform, and admin credentials.

**Report vulnerabilities privately to security@tnorth.com.** Please do not
open public issues for security reports. We aim to acknowledge within 48
hours.

In scope: auth bypass (admin tokens, `tn_admin_`/`tn_live_` keys), SQL
injection, SSRF via the sync worker or price providers, email-platform abuse
(unsubscribe bypass, audit-log evasion), rate-limit bypass enabling abuse.

Out of scope: volumetric DoS, reports requiring a compromised host, and the
public explorer/analytics data itself (it is intentionally public).

Secrets are stored hashed (except deliberately stable unsubscribe tokens);
the root `ADMIN_TOKEN` lives only in the deployment environment.
