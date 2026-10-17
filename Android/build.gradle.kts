// Root build file. Plugins are declared here once and applied by the modules,
// so the Android plugin's version lives in exactly one place (the version
// catalog) and the two modules cannot drift apart.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.google.services) apply false
}
