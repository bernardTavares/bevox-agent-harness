#!/usr/bin/env node
import { execSync } from "node:child_process";
execSync("docker compose down", { stdio: "inherit" });
console.log("✓ Infra stopped (volumes preserved)");
