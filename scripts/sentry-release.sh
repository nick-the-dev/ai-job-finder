#!/bin/bash
#
# Sentry Release Script
#
# This script creates a new Sentry release and uploads source maps.
# Run this after building the project (npm run build).
#
# Required environment variables:
#   SENTRY_AUTH_TOKEN - Sentry API token (from https://sentry.io/settings/auth-tokens/)
#   SENTRY_ORG        - Sentry organization slug
#   SENTRY_PROJECT    - Sentry project slug
#
# Usage:
#   ./scripts/sentry-release.sh
#
# The release version is read from package.json automatically.

set -e

# Check required environment variables
if [ -z "$SENTRY_AUTH_TOKEN" ]; then
  echo "Error: SENTRY_AUTH_TOKEN is not set"
  echo "Get your token from: https://sentry.io/settings/auth-tokens/"
  exit 1
fi

if [ -z "$SENTRY_ORG" ]; then
  echo "Error: SENTRY_ORG is not set"
  exit 1
fi

if [ -z "$SENTRY_PROJECT" ]; then
  echo "Error: SENTRY_PROJECT is not set"
  exit 1
fi

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
RELEASE="ai-job-finder@${VERSION}"

echo "Creating Sentry release: ${RELEASE}"

# Create new release
npx @sentry/cli releases new "$RELEASE"

# Upload source maps from dist directory
echo "Uploading source maps..."
npx @sentry/cli releases files "$RELEASE" upload-sourcemaps ./dist \
  --url-prefix '~/dist' \
  --rewrite

# Set commits (if in a git repo)
if [ -d ".git" ]; then
  echo "Setting commits..."
  npx @sentry/cli releases set-commits "$RELEASE" --auto
fi

# Finalize the release
echo "Finalizing release..."
npx @sentry/cli releases finalize "$RELEASE"

echo "Done! Release ${RELEASE} created and source maps uploaded."
echo "View in Sentry: https://sentry.io/organizations/${SENTRY_ORG}/releases/${RELEASE}/"
