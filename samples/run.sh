#!/bin/bash

node ../af.js --input "meridian.mp4" --output "../demo/assets/meridian_h264.af" --maxWidth 1920 --gop 5
node ../af.js --input "meridian.mp4" --output "../demo/assets/meridian_h265.af" --maxWidth 1920 --gop 5 --codec h265

node ../af.js --input "meridian_portrait.mp4" --output "../demo/assets/p_meridian_h264.af" --maxWidth 800 --gop 5
node ../af.js --input "meridian_portrait.mp4" --output "../demo/assets/p_meridian_h265.af" --maxWidth 800 --gop 5 --codec h265
