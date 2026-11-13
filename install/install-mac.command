#!/bin/bash
# Double-click to install or update the Charm Evaluator. Runs the latest install-mac.sh from the project's releases.
curl -fsSL https://github.com/snowball7241/monumenta-charm-eval/releases/latest/download/install-mac.sh | bash
status=$?
if [[ $status -ne 0 ]]; then
    echo
    echo "The installation did not finish. See the message above."
    read -r -p "Press Return to close this window."
fi
exit $status
