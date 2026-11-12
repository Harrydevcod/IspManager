plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
  id("app.cash.paparazzi")
}

android {
  namespace = "cv.novatech.ispm.sms"
  compileSdk = 35

  defaultConfig {
    applicationId = "cv.novatech.ispm.sms"
    minSdk = 26
    targetSdk = 35
    versionCode = 13
    versionName = "0.9.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  // Release signing comes only from CI secrets; without them the release build stays unsigned.
  val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")
  signingConfigs {
    if (keystorePath != null) {
      create("release") {
        storeFile = file(keystorePath)
        storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
    }
  }

  buildFeatures {
    compose = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  // Fingerprint or the phone PIN to open the app; brings androidx.fragment (FragmentActivity).
  implementation("androidx.biometric:biometric:1.1.0")
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.ui:ui:1.7.5")
  implementation("androidx.compose.material3:material3:1.3.1")
  // Explicit: bottom-nav icons; material3 stops re-exporting this in 1.4.
  implementation("androidx.compose.material:material-icons-core:1.7.5")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  implementation("org.nanohttpd:nanohttpd:2.3.1")
  testImplementation("junit:junit:4.13.2")
  // Real org.json on the JVM test classpath (android.jar only ships stubs).
  testImplementation("org.json:json:20240303")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
