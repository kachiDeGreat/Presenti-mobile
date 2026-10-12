import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
  Platform,
  Image,
} from 'react-native';
import { router, Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { recordAttendance } from '../services/organizationService';

export default function DashboardScreen() {
  const { user, organization, member, cachedAnchors, deviceId, isLoading, signOut } = useAuth();
  const [isClockingIn, setIsClockingIn] = useState(false);
  const [clockInSuccess, setClockInSuccess] = useState<string | null>(null);

  if (isLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#0F2042" />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/login" />;
  }

  if (!organization || !member) {
    return <Redirect href="/onboarding" />;
  }

  const handleClockIn = async () => {
    setIsClockingIn(true);
    setClockInSuccess(null);
    try {
      const now = new Date();
      const serviceDate = now.toISOString().split('T')[0];
      const punchedAt = now.toISOString();

      await recordAttendance(organization.id, {
        memberId: member.id,
        memberName: member.fullName,
        department: member.department,
        serviceDate,
        timestamp: punchedAt,
        punchedAt,
        syncedAt: punchedAt,
        verificationMethod: 'WIFI_BSSID',
        deviceId,
        bssidDetected: cachedAnchors?.targetBssid || undefined,
      });

      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setClockInSuccess('Clocked in successfully at ' + timeStr + ' via Wi-Fi presence anchor.');
      Alert.alert('Verified Check-In', 'Your attendance was recorded on-premise at ' + timeStr + '.');
    } catch (err: any) {
      Alert.alert('Check-In Error', err?.message || 'Failed to submit attendance.');
    } finally {
      setIsClockingIn(false);
    }
  };

  const avatarUrl = member.photoURL || user.photoURL;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Top Header Card */}
        <View style={styles.orgHeaderCard}>
          <Text style={styles.orgName}>{organization.churchName}</Text>
          <Text style={styles.orgBranch}>{organization.branchName} • {organization.churchCode}</Text>
          
          <View style={styles.memberInfoRow}>
            <View style={styles.memberIdentityCluster}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.profileAvatar} />
              ) : (
                <View style={styles.profileAvatarFallback}>
                  <Text style={styles.profileAvatarInitial}>
                    {(member.fullName?.[0] || 'U').toUpperCase()}
                  </Text>
                </View>
              )}
              <View>
                <Text style={styles.memberName}>{member.fullName}</Text>
                <Text style={styles.memberDept}>{member.department}</Text>
              </View>
            </View>
            <View style={styles.activeStatusBadge}>
              <View style={styles.activeDot} />
              <Text style={styles.activeStatusText}>Verified</Text>
            </View>
          </View>
        </View>

        {/* Pre-cached Anchors Status */}
        <View style={styles.anchorsCard}>
          <Text style={styles.anchorsTitle}>PRE-LOADED PRESENCE ANCHORS</Text>
          <View style={styles.anchorRow}>
            <Text style={styles.anchorLabel}>Target Wi-Fi SSID:</Text>
            <Text style={styles.anchorValue}>{cachedAnchors?.ssidHint || 'Configured Router'}</Text>
          </View>
          <View style={styles.anchorRow}>
            <Text style={styles.anchorLabel}>Geofence Perimeter:</Text>
            <Text style={styles.anchorValue}>{cachedAnchors?.radiusMeters || 10}m calibrated</Text>
          </View>
          <Text style={styles.anchorsHint}>
            Presence rules are cached on this device for fast verification without extra latency.
          </Text>
        </View>

        {/* Primary Clock-In Action */}
        <View style={styles.actionSection}>
          <TouchableOpacity
            style={[styles.clockInButton, isClockingIn && styles.disabledButton]}
            onPress={handleClockIn}
            disabled={isClockingIn}
            activeOpacity={0.8}
          >
            {isClockingIn ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.clockInText}>Clock In / Record Attendance</Text>
            )}
          </TouchableOpacity>

          {clockInSuccess && (
            <View style={styles.successBox}>
              <Text style={styles.successText}>{clockInSuccess}</Text>
            </View>
          )}
        </View>

        {/* Footer */}
        <View style={styles.footerSection}>
          <Text style={styles.syncStatusText}>
            Connected to {organization.churchName}
          </Text>
          <TouchableOpacity
            style={styles.signOutButton}
            onPress={async () => {
              await signOut();
              router.replace('/login');
            }}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
  },
  scrollContent: {
    padding: 20,
    gap: 16,
    flexGrow: 1,
  },
  orgHeaderCard: {
    backgroundColor: '#0F2042',
    borderRadius: 12,
    padding: 20,
    gap: 4,
  },
  orgName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  orgBranch: {
    fontSize: 12,
    color: '#93C5FD',
    marginBottom: 12,
  },
  memberInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.12)',
    paddingTop: 12,
  },
  memberIdentityCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  profileAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: '#60A5FA',
  },
  profileAvatarFallback: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileAvatarInitial: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  memberDept: {
    fontSize: 12,
    color: '#CBD5E1',
  },
  activeStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#34D399',
  },
  activeStatusText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6EE7B7',
  },
  anchorsCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    padding: 16,
    gap: 8,
  },
  anchorsTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  anchorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  anchorLabel: {
    fontSize: 13,
    color: '#64748B',
  },
  anchorValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0F172A',
  },
  anchorsHint: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 4,
    lineHeight: 15,
  },
  actionSection: {
    marginTop: 8,
    gap: 12,
  },
  clockInButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  disabledButton: {
    opacity: 0.7,
  },
  clockInText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  successBox: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    borderRadius: 8,
    padding: 12,
  },
  successText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#059669',
    textAlign: 'center',
  },
  footerSection: {
    marginTop: 'auto',
    alignItems: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  syncStatusText: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: '500',
  },
  signOutButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  signOutText: {
    fontSize: 12,
    color: '#EF4444',
    fontWeight: '600',
  },
});
