use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

struct GitLayout {
    git_dir: PathBuf,
    common_dir: PathBuf,
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let workspace_root = find_workspace_root(&manifest_dir).unwrap_or_else(|| manifest_dir.clone());
    let repo_root = find_repo_root(&manifest_dir);

    emit_package_watchers(&workspace_root);
    if let Some(repo_root) = repo_root.as_deref() {
        emit_git_watchers(repo_root);
    }

    println!("cargo:rerun-if-env-changed=APP_VERSION");
    println!("cargo:rerun-if-env-changed=BUILD_NUMBER");
    println!("cargo:rerun-if-env-changed=BUILD_DATE");
    println!("cargo:rerun-if-env-changed=GIT_URL");
    println!("cargo:rerun-if-env-changed=GIT_SHA");
    println!("cargo:rerun-if-env-changed=GIT_DIRTY");

    let app_version = env_value("APP_VERSION")
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".to_string()));
    let build_number = env_value("BUILD_NUMBER").unwrap_or_default();
    let build_date = env_value("BUILD_DATE").unwrap_or_else(|| {
        run_git(&manifest_dir, &["log", "-1", "--format=%cI"])
            .unwrap_or_else(|| "unknown".to_string())
    });
    let git_url = env_value("GIT_URL")
        .or_else(|| run_git(&manifest_dir, &["config", "--get", "remote.origin.url"]))
        .unwrap_or_else(|| "unknown".to_string());
    let git_sha = env_value("GIT_SHA")
        .or_else(|| run_git(&manifest_dir, &["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());

    let git_dirty = env_value("GIT_DIRTY")
        .map(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"))
        .unwrap_or_else(|| {
            run_git(
                &manifest_dir,
                &["status", "--porcelain", "--untracked-files=no"],
            )
            .map(|output| !output.trim().is_empty())
            .unwrap_or(false)
        });

    println!("cargo:rustc-env=APP_VERSION={app_version}");
    println!("cargo:rustc-env=BUILD_NUMBER={build_number}");
    println!("cargo:rustc-env=BUILD_DATE={build_date}");
    println!("cargo:rustc-env=GIT_URL={git_url}");
    println!("cargo:rustc-env=GIT_SHA={git_sha}");
    println!(
        "cargo:rustc-env=GIT_DIRTY={}",
        if git_dirty { "true" } else { "false" }
    );
}

fn emit_package_watchers(workspace_root: &Path) {
    for path in ["build.rs", "Cargo.toml", "Cargo.lock"] {
        watch_path(&workspace_root.join(path));
    }
}

fn emit_git_watchers(repo_root: &Path) {
    let Some(layout) = git_layout(repo_root) else {
        return;
    };

    watch_path(&layout.git_dir.join("HEAD"));
    watch_path(&layout.git_dir.join("index"));
    watch_path(&layout.common_dir.join("packed-refs"));

    if let Some(head_ref) = read_head_ref(&layout.git_dir.join("HEAD")) {
        watch_path(&layout.common_dir.join(head_ref));
    }
}

fn watch_path(path: &Path) {
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn find_workspace_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|ancestor| {
        let cargo_toml = ancestor.join("Cargo.toml");
        let contents = fs::read_to_string(&cargo_toml).ok()?;
        if contents.contains("[workspace]") {
            Some(ancestor.to_path_buf())
        } else {
            None
        }
    })
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|ancestor| {
        let dot_git = ancestor.join(".git");
        if dot_git.exists() {
            Some(ancestor.to_path_buf())
        } else {
            None
        }
    })
}

fn git_layout(repo_root: &Path) -> Option<GitLayout> {
    let dot_git = repo_root.join(".git");

    if dot_git.is_dir() {
        return Some(GitLayout {
            git_dir: dot_git.clone(),
            common_dir: dot_git,
        });
    }

    let git_dir = resolve_git_dir_from_file(&dot_git)?;
    let common_dir = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .and_then(|value| resolve_relative_path(&git_dir, value.trim()))
        .unwrap_or_else(|| git_dir.clone());

    Some(GitLayout {
        git_dir,
        common_dir,
    })
}

fn resolve_git_dir_from_file(dot_git: &Path) -> Option<PathBuf> {
    let value = fs::read_to_string(dot_git).ok()?;
    let git_dir = value.strip_prefix("gitdir:")?.trim();
    resolve_relative_path(dot_git.parent()?, git_dir)
}

fn resolve_relative_path(base_dir: &Path, raw_path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw_path);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(base_dir.join(path))
    }
}

fn read_head_ref(head_path: &Path) -> Option<String> {
    let head = fs::read_to_string(head_path).ok()?;
    let head = head.trim();
    head.strip_prefix("ref: ").map(ToOwned::to_owned)
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn run_git(working_dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(working_dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}
