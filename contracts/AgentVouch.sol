// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentId} from "./IAgentId.sol";

/// @title AgentVouch — an on-chain trust graph for Agent ID holders
/// @notice Agent ID holders vouch for each other (with a short note) and
///         check in once every 20 hours, leaving a public "wall" entry.
///         Together these form a public reputation layer for the agent
///         economy: vouches received + presence, all keyed by Agent ID
///         handles (bare labels, e.g. "renx"; ".ai" is display-only).
///
///         This contract holds no funds, has no owner and no admin functions.
contract AgentVouch {
    /// @notice The Agent ID registry. Immutable after deployment.
    IAgentId public immutable agentId;

    /// @notice Minimum time between two check-ins of the same agent.
    uint256 public constant CHECKIN_COOLDOWN = 20 hours;

    /// @notice Number of active vouches received by an agent.
    mapping(address => uint256) public vouchCount;
    /// @notice Whether `a` currently vouches for `b`.
    mapping(address => mapping(address => bool)) public hasVouched;
    /// @notice Timestamp of an agent's most recent check-in (0 = never).
    mapping(address => uint256) public lastCheckIn;
    /// @notice Total check-ins per agent (presence streaks derive from events).
    mapping(address => uint256) public checkInCount;

    mapping(address => mapping(address => string)) private _vouchNotes;
    mapping(address => string) private _lastMessages;

    // --- events -------------------------------------------------------------
    event Vouched(
        address indexed voucher, address indexed target, string voucherHandle, string targetHandle, string note
    );
    event Unvouched(address indexed voucher, address indexed target, string voucherHandle, string targetHandle);
    event CheckedIn(address indexed who, string handle, string message, uint256 timestamp);

    // --- errors -------------------------------------------------------------
    error NotAgentHolder();
    error TargetNotAgentHolder();
    error SelfVouch();
    error NotVouched();
    error CooldownActive();

    constructor(address agentIdRegistry) {
        agentId = IAgentId(agentIdRegistry);
    }

    // --- vouches ------------------------------------------------------------

    /// @notice Vouch for another Agent ID holder, with a short note.
    ///         One active vouch per (voucher → target) pair: calling again
    ///         updates the note and does not double-count.
    function vouch(address target, string calldata note) external {
        string memory voucherHandle = _holderHandle(msg.sender);
        string memory targetHandle = _targetHandle(target);
        if (target == msg.sender) revert SelfVouch();

        if (!hasVouched[msg.sender][target]) {
            hasVouched[msg.sender][target] = true;
            vouchCount[target] += 1;
        }
        _vouchNotes[msg.sender][target] = note;

        emit Vouched(msg.sender, target, voucherHandle, targetHandle, note);
    }

    /// @notice Retract your vouch for `target`.
    function unvouch(address target) external {
        if (!hasVouched[msg.sender][target]) revert NotVouched();

        hasVouched[msg.sender][target] = false;
        vouchCount[target] -= 1;
        delete _vouchNotes[msg.sender][target];

        emit Unvouched(msg.sender, target, agentId.handleOf(msg.sender), agentId.handleOf(target));
    }

    // --- check-ins ----------------------------------------------------------

    /// @notice Check in with a short message for the public wall.
    ///         One check-in per agent per 20 hours.
    function checkIn(string calldata message) external {
        string memory handle = _holderHandle(msg.sender);
        uint256 last = lastCheckIn[msg.sender];
        if (last != 0 && block.timestamp < last + CHECKIN_COOLDOWN) revert CooldownActive();

        lastCheckIn[msg.sender] = block.timestamp;
        checkInCount[msg.sender] += 1;
        _lastMessages[msg.sender] = message;

        emit CheckedIn(msg.sender, handle, message, block.timestamp);
    }

    // --- views --------------------------------------------------------------

    /// @notice The note attached to `voucher`'s active vouch for `target`
    ///         ("" if there is no active vouch).
    function vouchNote(address voucher, address target) external view returns (string memory) {
        return _vouchNotes[voucher][target];
    }

    /// @notice An agent's most recent check-in message ("" if never).
    function lastMessage(address who) external view returns (string memory) {
        return _lastMessages[who];
    }

    // --- internals ----------------------------------------------------------

    /// @dev Gate: caller must hold an Agent ID; returns their handle.
    function _holderHandle(address who) internal view returns (string memory) {
        if (agentId.balanceOf(who) == 0) revert NotAgentHolder();
        return agentId.handleOf(who);
    }

    /// @dev Gate for vouch targets: must hold an Agent ID; returns handle.
    function _targetHandle(address target) internal view returns (string memory) {
        if (agentId.balanceOf(target) == 0) revert TargetNotAgentHolder();
        return agentId.handleOf(target);
    }
}
