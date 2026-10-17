// The protocol layer: frames, pairing, the connection state machine, the
// conversation projection and the stores. Plain Kotlin/JVM on purpose -- no
// Android types anywhere in here, so `./gradlew :mizarkit:test` runs the whole
// contract suite on the host in about a second.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    api(libs.okhttp)

    testImplementation(kotlin("test"))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.junit.jupiter.params)
    testRuntimeOnly(libs.junit.jupiter.engine)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        showStandardStreams = false
    }
}

/**
 * Dial a running host and exercise the protocol over the real wire.
 *
 * The Android equivalent of `scripts/smoke-listener.mjs`: the JVM tests prove
 * the parser reads the golden frames, and this proves the client agrees with a
 * host that is actually running. Needs a live dev instance:
 *
 *   ./gradlew :mizarkit:hostCheck -Pbase=http://127.0.0.1:19390 -Pcode=XXXX-XXXX
 */
tasks.register<JavaExec>("hostCheck") {
    group = "verification"
    description = "Exercise pair/hello/session calls against a running Mizar host."
    mainClass.set("me.shirazu.mizar.kit.tools.HostCheckKt")
    classpath = sourceSets["main"].runtimeClasspath
    (project.findProperty("base") as String?)?.let { environment("MIZAR_BASE", it) }
    (project.findProperty("code") as String?)?.let { environment("MIZAR_CODE", it) }
    (project.findProperty("web") as String?)?.let { environment("MIZAR_WEB_BASE", it) }
    (project.findProperty("webToken") as String?)?.let { environment("MIZAR_WEB_TOKEN", it) }
}
