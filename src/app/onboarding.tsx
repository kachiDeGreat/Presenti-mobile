import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';

export default function OnboardingScreen() {
  const { user, organization, member, pairOrganization, completeRegistration } = useAuth();

  const [churchCodeInput, setChurchCodeInput] = useState(organization?.churchCode || '');
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [verifiedOrg, setVerifiedOrg] = useState(organization);

  const [fullName, setFullName] = useState(user?.displayName || '');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedDept, setSelectedDept] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  useEffect(() => {
    if (verifiedOrg && verifiedOrg.departments.length > 0 && !selectedDept) {
      setSelectedDept(verifiedOrg.departments[0]);
    }
  }, [verifiedOrg, selectedDept]);

  // If already registered, jump to dashboard
  useEffect(() => {
    if (verifiedOrg && member) {
      router.replace('/');
    }
  }, [verifiedOrg, member]);

  const handleVerifyCode = async () => {
    if (!churchCodeInput.trim()) {
      Alert.alert('Required', 'Please enter your organization code.');
      return;
    }

    setIsVerifyingCode(true);
    try {
      const org = await pairOrganization(churchCodeInput);
      setVerifiedOrg(org);
      if (org.departments.length > 0) {
        setSelectedDept(org.departments[0]);
      }
      Alert.alert('Verified', 'Paired with ' + org.churchName + '. Anchors cached on device.');
    } catch (err: any) {
      Alert.alert('Verification Failed', err?.message || 'Could not find organization.');
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleCompleteRegistration = async () => {
    if (!fullName.trim()) {
      Alert.alert('Required', 'Please enter your full name.');
      return;
    }
    if (!phoneNumber.trim()) {
      Alert.alert('Required', 'Please enter your phone number.');
      return;
    }
    if (!selectedDept) {
      Alert.alert('Required', 'Please select your department.');
      return;
    }

    setIsRegistering(true);
    try {
      await completeRegistration(fullName, phoneNumber, selectedDept);
      Alert.alert('Registration Successful', 'Welcome to ' + (verifiedOrg?.churchName || 'the organization') + '!', [
        {
          text: 'Continue to Dashboard',
          onPress: () => router.replace('/'),
        },
      ]);
    } catch (err: any) {
      Alert.alert('Registration Error', err?.message || 'Failed to complete enrollment.');
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.brandTag}>STEP {verifiedOrg ? '2 OF 2' : '1 OF 2'}</Text>
            <Text style={styles.title}>
              {verifiedOrg ? 'Department Enrollment' : 'Organization Pairing'}
            </Text>
            <Text style={styles.subtitle}>
              {verifiedOrg
                ? 'Select your assigned unit to link your profile to ' + verifiedOrg.churchName + '.'
                : 'Enter the organization code provided by your administrator to pull settings and presence anchors.'}
            </Text>
          </View>

          {/* Step 1: Code Verification */}
          {!verifiedOrg ? (
            <View style={styles.stepContainer}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Organization Code *</Text>
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  placeholder="e.g. CP-8841-A"
                  placeholderTextColor="#94A3B8"
                  value={churchCodeInput}
                  onChangeText={(t) => setChurchCodeInput(t.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, isVerifyingCode && styles.disabledButton]}
                onPress={handleVerifyCode}
                disabled={isVerifyingCode}
                activeOpacity={0.8}
              >
                {isVerifyingCode ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryButtonText}>Verify & Cache Anchors</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.stepContainer}>
              {/* Paired Org Confirmation Banner */}
              <View style={styles.orgInfoCard}>
                <Text style={styles.orgNameText}>{verifiedOrg.churchName}</Text>
                <Text style={styles.orgBranchText}>{verifiedOrg.branchName} • Code: {verifiedOrg.churchCode}</Text>
                <Text style={styles.orgAnchorText}>
                  Presence anchors (Wi-Fi: {verifiedOrg.beaconConfig.ssidHint || 'Configured'} & Geofence: {verifiedOrg.geoFallback.radiusMeters}m) cached locally.
                </Text>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full Name *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Brother Samuel"
                  placeholderTextColor="#94A3B8"
                  value={fullName}
                  onChangeText={setFullName}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Phone Number *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. +234 803 123 4567"
                  placeholderTextColor="#94A3B8"
                  value={phoneNumber}
                  onChangeText={setPhoneNumber}
                  keyboardType="phone-pad"
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Department Unit *</Text>
                <View style={styles.deptChipsContainer}>
                  {verifiedOrg.departments.map((dept) => {
                    const isSelected = selectedDept === dept;
                    return (
                      <TouchableOpacity
                        key={dept}
                        style={[styles.deptChip, isSelected && styles.deptChipSelected]}
                        onPress={() => setSelectedDept(dept)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.deptChipText, isSelected && styles.deptChipTextSelected]}>
                          {dept}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, isRegistering && styles.disabledButton]}
                onPress={handleCompleteRegistration}
                disabled={isRegistering}
                activeOpacity={0.8}
              >
                {isRegistering ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryButtonText}>Complete Profile Setup</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scrollContent: {
    padding: 24,
    flexGrow: 1,
  },
  header: {
    marginBottom: 24,
  },
  brandTag: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
    letterSpacing: 1,
    marginBottom: 6,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.4,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
  },
  stepContainer: {
    gap: 16,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: '#0F172A',
  },
  codeInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
    textAlign: 'center',
    paddingVertical: 14,
  },
  primaryButton: {
    backgroundColor: '#0F2042',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  disabledButton: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  orgInfoCard: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    padding: 14,
  },
  orgNameText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E3A8A',
  },
  orgBranchText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#2563EB',
    marginTop: 2,
  },
  orgAnchorText: {
    fontSize: 11,
    color: '#3B82F6',
    marginTop: 6,
    lineHeight: 15,
  },
  deptChipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  deptChip: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deptChipSelected: {
    backgroundColor: '#0F2042',
    borderColor: '#0F2042',
  },
  deptChipText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '500',
  },
  deptChipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  lockNotice: {
    backgroundColor: '#F1F5F9',
    borderRadius: 6,
    padding: 10,
  },
  lockNoticeText: {
    fontSize: 11,
    color: '#64748B',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
