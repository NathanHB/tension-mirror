// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TensionMirrorMac",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "TensionMirrorMac"
        )
    ]
)
