#!/usr/bin/env bash
# Parallel git worktrees, one Cursor window each.
#
#   scripts/worktree.sh create branch-2        new worktree + its own copy of the generated data
#   scripts/worktree.sh refresh-data branch-2  replace that worktree's generated data with the main checkout's
#
# Worktrees live next to each other in ../creek-water-visualization/<name>, with a
# <name>.code-workspace file to open in Cursor.
#
# Generated data (the pipeline working output, the frozen data-product versions, and the
# live-test response cache) is gitignored, so git never brings it into a worktree. A
# folder the main checkout does not have yet is skipped. Each worktree gets its own APFS clone of the
# main checkout's copy: instant, and it takes no extra disk until a file changes.
# Nothing is shared or symlinked, so one window's pipeline run cannot change another's
# data, and nothing generated can end up in a commit or a merge.
set -euo pipefail

GENERATED_DATA_FOLDERS=(
  "data/pipeline-working-output"
  "data/data-product-versions"
  ".test-cache"
)

command_name="${1:-}"
worktree_name="${2:-}"
if [[ -z "$command_name" || -z "$worktree_name" ]]; then
  echo "Usage: scripts/worktree.sh create|refresh-data <name>" >&2
  exit 1
fi

# The main checkout is the folder that owns the shared .git directory.
main_checkout="$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd)"
worktree_parent="$(dirname "$main_checkout")/creek-water-visualization"
worktree_path="$worktree_parent/$worktree_name"

clone_generated_data() {
  for folder in "${GENERATED_DATA_FOLDERS[@]}"; do
    if [[ ! -d "$main_checkout/$folder" ]]; then
      echo "  skip $folder (not in the main checkout yet)"
      continue
    fi
    rm -rf "${worktree_path:?}/$folder"
    mkdir -p "$(dirname "$worktree_path/$folder")"
    # -c clones with clonefile(2): copy-on-write, so this is instant and shares disk blocks.
    cp -cR "$main_checkout/$folder" "$worktree_path/$folder"
    echo "  cloned $folder"
  done
}

title_bar_color() {
  case "$1" in
    branch-1) echo "#B35C00" ;; # orange
    branch-2) echo "#1A6B3A" ;; # green
    branch-3) echo "#6B2FA0" ;; # purple
    *) echo "#5C5C5C" ;;        # gray
  esac
}

write_workspace_file() {
  local workspace_file="$worktree_parent/$worktree_name.code-workspace"
  [[ -f "$workspace_file" ]] && return
  cat >"$workspace_file" <<EOF
{
  "folders": [{ "name": "$worktree_name", "path": "$worktree_name" }],
  "settings": {
    "window.title": "$worktree_name — \${activeEditorShort}",
    "workbench.colorCustomizations": {
      "titleBar.activeBackground": "$(title_bar_color "$worktree_name")",
      "titleBar.activeForeground": "#FFFFFF",
      "titleBar.inactiveBackground": "$(title_bar_color "$worktree_name")",
      "titleBar.inactiveForeground": "#DDDDDD"
    }
  }
}
EOF
  echo "  wrote $workspace_file"
}

case "$command_name" in
  create)
    if [[ -e "$worktree_path" ]]; then
      echo "$worktree_path already exists." >&2
      exit 1
    fi
    base_branch="$(git -C "$main_checkout" rev-parse --abbrev-ref HEAD)"
    mkdir -p "$worktree_parent"
    echo "Creating ${worktree_name} from ${base_branch}..."
    git -C "$main_checkout" worktree add -b "$worktree_name" "$worktree_path" "$base_branch"
    clone_generated_data
    echo "  installing packages..."
    (cd "$worktree_path" && npm install --silent)
    write_workspace_file
    echo "Done. In Cursor: File > Open Workspace from File... > ${worktree_parent}/${worktree_name}.code-workspace"
    ;;
  refresh-data)
    if [[ ! -d "$worktree_path" ]]; then
      echo "No worktree at $worktree_path." >&2
      exit 1
    fi
    echo "Replacing ${worktree_name}'s generated data with the main checkout's..."
    clone_generated_data
    ;;
  *)
    echo "Unknown command '$command_name'. Use create or refresh-data." >&2
    exit 1
    ;;
esac
