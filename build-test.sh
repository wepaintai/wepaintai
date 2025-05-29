#!/bin/bash

echo "Building project with updated configuration..."
npm run build

echo "Checking for CSS files in the build output..."
find dist -name "*.css" -type f

echo "Done! If CSS files are found above, the build process is correctly generating CSS."
