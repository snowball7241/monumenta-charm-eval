# Multi-Threaded Zenith Charm Evaluator

A fast Zenith Charm evaluation tool written in C++, optimized for multithreaded performance and modern superscalar processors.

## Usage

### Prebuilt binaries

Download the archive for your platform from the [Releases](../../releases) page, extract it, and run `mtce` (`mtce.exe` on Windows)
as shown under [Running](#running).

| Archive | Runs on |
|---|---|
| `macos-arm64` | Apple Silicon Macs, macOS 13.3+ |
| `macos-x86_64` | Intel Macs, macOS 13.3+ |
| `linux-x86_64` | any x86_64 Linux with AVX2 (fully static, no dependencies) |
| `windows-x86_64` | 64-bit Windows with AVX2 (no Visual C++ redistributable needed) |

AVX2 is available on practically every x86 CPU made since ~2015. The binaries are not code-signed: on macOS, clear the download
quarantine with `xattr -d com.apple.quarantine mtce` (or right-click → Open once); on Windows, choose "More info → Run anyway" if
SmartScreen warns.

Prebuilt binaries are compiled for a broad CPU baseline, so they are roughly 10-20% slower than a build tuned with `-march=native`.
The list of charm effects is compiled in: after a Monumenta update that adds or renames effects, use a newer release (or rebuild).

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed.

### Building

For best performance, it is strongly recommended to build from source. Modern CPUs support features like AVX, which can significantly improve
performance. Building from source allows the compiler to generate optimized code specific to your system.

#### Linux

**Dependencies:** `meson`, `ninja`, `clang`

It is important to use Clang. In benchmarks, Clang 19.1.1 showed a ~4x speedup over GCC 14.2.1.

This project uses C++23, so a relatively modern compiler is required.

Build steps:
```sh
$ CC=clang CXX=clang++ CXXFLAGS="-O3 -march=native" meson setup build --buildtype=custom
$ cd build
$ ninja -j4
```

#### Windows

##### Prepare Dependencies

- Clang: install the latest `LLVM-(VersionNumberHere)-win64.exe` from [LLVM Releases](https://github.com/llvm/llvm-project/releases)
- Meson & Ninja
    - Install [Python](https://www.python.org/downloads/) first
	- Type `pip install meson` and `pip install ninja` in cmd (Win+R, type `cmd` and enter)
- C++ Library
	- Download [VS Build Tool](https://visualstudio.microsoft.com/visual-cpp-build-tools/). During installation, select the "Desktop development with C++" workload.

##### Build

Install [Git](https://git-scm.com/download/win) first. During installation, choose the option to “Add Git to PATH” (usually it is by default).

Open PowerShell (Win+X) and type
```PowerShell
git clone https://github.com/Floweynt/monumenta-charm-eval.git
cd monumenta-charm-eval
```

Wait till it's done, then type 
```PowerShell
$env:CC="clang"
$env:CXX="clang++"
meson setup build --buildtype=release -Dcpp_args="-O3 -march=native"
```

Wait till it's done, then type 
```PowerShell
cd build
ninja -j4
```

### Configuration

The configuration file is simple:

```
charm_power = 15
# optional: upgrading charms is expensive in game
max_upgrades = 2      # at most 2 upgraded "(u)" charms per set (0 = only charms as they are; default: no limit)
upgrade_penalty = 3   # each upgraded charm costs as much as an effect with weight 3 going from 0 to its cap (default: 0)

[weights]
# example weights
volcanic_meteor_cooldown = 10000
volcanic_meteor_damage = 9000
volcanic_meteor_radius = 7000
# ...
```

Assign higher weights to more important effects. Avoid specifying weights for effects you don't care about - performance optimizations rely on
minimizing the number of effects.

`max_upgrades` is a hard limit; `upgrade_penalty` is a soft cost that only lets an upgrade in when it improves the set by more than the
penalty. They can be combined. Both can also be given on the command line as `--config-max-upgrades` and `--config-upgrade-penalty`.

### Running

1. Write up the config (example file at `monumenta-charm-eval/samples`) and save it as a file at `monumenta-charm-eval/build`.
2. Grab charm data with Flowey's Monumenta Addons mod (v1.8+), press the keybind (I by default) when hovering your mouse on each cz charms you'd like to use, then type the command the Toast just told you, paste and save it as .txt file at `monumenta-charm-eval/build`

Run the program from the command line:

Linux:
```sh
$ ./mtce --config YourConfigNameHere.conf --in YourCharmDataSetNameHere.txt
```

Windows:
```Powershell
.\mtce.exe --config YourConfigNameHere.conf --in YourCharmDataSetNameHere.txt
```

Advanced options (specifying different algorithms, etc) can be done with additional CLI flags. Use `--help` to see available options:
```sh
$ ./mtce --help
```

## Future Work

- [ ] Tree pruning  
- [ ] GPU acceleration

Submit a PR if you'd like to help write the Windows guide or add examples for config files or datasets.
