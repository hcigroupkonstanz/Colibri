#!/bin/bash
SCRIPT_DIR=`dirname "$0"`
docker build -t hci-uni-kn/colibri "$SCRIPT_DIR"
