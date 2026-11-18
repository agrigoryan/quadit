# The Homebrew cask for the desktop app, a template for the tap
# agrigoryan/homebrew-tap (Casks/quadit-desktop.rb). For a release
# desktop-vX.Y.Z: set the version, and the two sha256 lines from the
# release's SHA256SUMS.txt. Then: brew install --cask agrigoryan/tap/quadit-desktop
# Updating is brew upgrade --cask quadit-desktop; the app only says when a
# new version is out.
cask "quadit-desktop" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "REPLACE_WITH_SHA256_OF_Quadit-#{version}-mac-arm64.dmg",
         intel: "REPLACE_WITH_SHA256_OF_Quadit-#{version}-mac-x64.dmg"

  url "https://github.com/agrigoryan/quadit/releases/download/desktop-v#{version}/Quadit-#{version}-mac-#{arch}.dmg"
  name "Quadit"
  desc "Desktop app for Quadit, the self-hosted task and docs tool for people and AI agents"
  homepage "https://github.com/agrigoryan/quadit"

  livecheck do
    url :url
    regex(/^desktop-v(\d+(?:\.\d+)+)$/i)
    strategy :github_releases
  end

  # The app needs macOS 13 (its Info.plist, and Electron itself).
  depends_on macos: ">= :ventura"

  app "Quadit.app"

  zap trash: [
    "~/Library/Application Support/Quadit",
    "~/Library/Preferences/io.github.agrigoryan.quadit.plist",
    "~/Library/Saved Application State/io.github.agrigoryan.quadit.savedState",
  ]
end
