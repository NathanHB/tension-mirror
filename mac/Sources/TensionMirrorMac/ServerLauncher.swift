import Foundation

/// Launches the existing Flask app (tension-mirror) as a subprocess and
/// waits for it to start accepting connections. Kept deliberately dumb:
/// all real logic lives in the Python app, this just boots/stops it.
final class ServerLauncher {
    let port: Int
    private var process: Process?

    // Resolved from this source file's own compile-time path rather than a
    // hardcoded absolute path, so it works on whatever machine builds it -
    // repo layout is assumed to be <repo root>/app.py and <repo root>/mac/...
    private let projectDir: String = {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // ServerLauncher.swift -> TensionMirrorMac/
            .deletingLastPathComponent() // -> Sources/
            .deletingLastPathComponent() // -> mac/
            .deletingLastPathComponent() // -> repo root
            .path
    }()

    init(port: Int) {
        self.port = port
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)/")!
    }

    func start(completion: @escaping (Bool) -> Void) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "\(projectDir)/venv/bin/gunicorn")
        process.arguments = ["app:app", "--bind", "127.0.0.1:\(port)", "--workers", "1"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectDir)

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            self.process = process
        } catch {
            print("Failed to launch server: \(error)")
            completion(false)
            return
        }

        waitUntilReady(attemptsLeft: 40, completion: completion)
    }

    private func waitUntilReady(attemptsLeft: Int, completion: @escaping (Bool) -> Void) {
        guard attemptsLeft > 0 else {
            completion(false)
            return
        }

        var request = URLRequest(url: baseURL)
        request.timeoutInterval = 0.5
        let task = URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                completion(true)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self.waitUntilReady(attemptsLeft: attemptsLeft - 1, completion: completion)
                }
            }
        }
        task.resume()
    }

    func stop() {
        process?.terminate()
        process = nil
    }
}
