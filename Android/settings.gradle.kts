// DSH-Mizar Android client.
//
// Two modules, for the same reason the iOS side is a Swift package plus an app
// target: `mizarkit` is the protocol layer and its tests run on a plain JVM in
// about a second, while anything that needs a device or an emulator costs far
// more per iteration. The app module owns the Compose UI, Firebase Messaging and
// the notification plumbing, none of which the protocol layer should depend on.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "dsh-mizar-android"

include(":mizarkit")
include(":app")
