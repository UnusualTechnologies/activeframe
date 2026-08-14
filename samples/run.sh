#!/bin/bash
# Regenerates the demo assets served from docs/ (the GitHub Pages root). Uses --mode cpu so this
# runs anywhere; the gpu default needs an NVIDIA card.
#
# --forceAllKeyframes false is required for --gop to take effect: it defaults to true, which forces
# every frame to a keyframe and quadruples these files.

node ../af.js --input "meridian.mp4" --output "../docs/assets/meridian_h264.af" --maxWidth 1920 --gop 5 --mode cpu --forceAllKeyframes false
node ../af.js --input "meridian.mp4" --output "../docs/assets/meridian_h265.af" --maxWidth 1920 --gop 5 --mode cpu --forceAllKeyframes false --codec h265

node ../af.js --input "meridian_portrait.mp4" --output "../docs/assets/p_meridian_h264.af" --maxWidth 800 --gop 5 --mode cpu --forceAllKeyframes false
node ../af.js --input "meridian_portrait.mp4" --output "../docs/assets/p_meridian_h265.af" --maxWidth 800 --gop 5 --mode cpu --forceAllKeyframes false --codec h265
