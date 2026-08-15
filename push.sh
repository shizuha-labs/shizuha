#!/bin/bash
# Push changes to upstream
set -e

BRANCH=master
echo "Pushing $BRANCH to origin..."
git push origin "$BRANCH"
echo "Done!"
