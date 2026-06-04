plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "cv.novatech.ispm.sms"
  compileSdk = 35

  defaultConfig {
    applicationId = "cv.novatech.ispm.sms"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.ui:ui:1.7.5")
  implementation("androidx.compose.material3:material3:1.3.1")
  implementation("org.nanohttpd:nanohttpd:2.3.1")
  testImplementation("junit:junit:4.13.2")
}
