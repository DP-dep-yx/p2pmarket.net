// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/**
 * @notice Minimal Chainlink Data Feed interface (latestRoundData only).
 * @dev ETH/USD on Base mainnet: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 (answer = USD per 1 ETH, 8 dp).
 */
interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title TrustMarketsTrade
 * @notice Hybrid B2B Trade, Audit, Credit Pool & Cargo Insurance Contract on Base L2 (Trust Net v17.2)
 * @dev Covers Smart Contract Types 3, 4, 5, and 6:
 *      - Type 3: Hybrid Sale (With USDC Escrow OR Non-Escrow Net-30/60 Commercial Invoice Registry)
 *      - Type 4: Independent Auditor Validation & Quality Attestation
 *      - Type 5: Deal-Collateralized Credit Pool (USDC working capital into Escrow)
 *      - Type 6: Parametric Cargo & Logistics Insurance in USDC
 *      v17.2: 0.1% protocol fee (DEAL_FEE_BPS) is charged on EVERY registered deal with an
 *      amount — USDC escrow and Net-30/60 invoices alike — paid in native Base ETH at the live
 *      Chainlink ETH/USD rate inside createDeal(), with any overpay refunded to the sender.
 *      The escrowed USDC itself is never deducted: the full deal amount reaches the seller.
 */
contract TrustMarketsTrade {
    enum DealStatus {
        Created,
        FundedOrActive,
        Shipped,
        Audited,
        Settled,
        Disputed,
        Defaulted
    }

    struct TradeDeal {
        uint256 id;
        address buyer;
        address seller;
        address auditor;            // Type 4: Independent quality/warehouse validator
        address lender;             // Type 5: Credit provider (optional)
        address insurer;            // Type 6: Insurance provider (optional)
        uint256 amountUsdc;         // 6 decimals (Base USDC) — deal face value
        uint256 creditPrincipalUsdc;
        uint256 insuranceCoverageUsdc;
        uint256 dueTimestamp;       // Net-30 / Net-60 maturity for non-escrow invoices
        bytes32 termsHash;          // IPFS/SHA-256 hash of Incoterms, SKU spec & JSON-LD offer
        bytes32 auditReportHash;    // Signed auditor inspection hash
        bool isEscrowEnabled;       // true = USDC locked in contract; false = Net-30/60 invoice registry
        bool settledOnTime;
        DealStatus status;
    }

    IERC20 public immutable usdc;
    address public immutable treasury;                  // fee recipient (platform, wallet B)
    AggregatorV3Interface public immutable ethUsdFeed;   // Chainlink ETH/USD (8 dp), network-specific
    uint16 public constant DEAL_FEE_BPS = 10;           // 0.1% of the deal amount (USD)
    uint256 public constant MAX_PRICE_AGE = 24 hours;   // staleness guard for the oracle
    uint256 public nextDealId;

    mapping(uint256 => TradeDeal) internal deals; // explicit getDeal() accessor: 15 полей не влезают в авто-геттер
    mapping(address => uint256) public completedDealsCount;
    mapping(address => uint256) public auditedDealsCount;
    mapping(address => uint256) public onTimeInvoiceSettlements;

    event DealCreated(
        uint256 indexed dealId,
        address indexed buyer,
        address indexed seller,
        uint256 amountUsdc,
        bool isEscrowEnabled,
        uint256 dueTimestamp
    );
    event EscrowFunded(uint256 indexed dealId, address indexed funder, uint256 amountUsdc);
    event CreditProvided(uint256 indexed dealId, address indexed lender, uint256 principalUsdc);
    event InsuranceAttached(uint256 indexed dealId, address indexed insurer, uint256 coverageUsdc);
    event ShipmentConfirmed(uint256 indexed dealId, bytes32 billOfLadingHash);
    event AuditorVerified(uint256 indexed dealId, address indexed auditor, bytes32 reportHash);
    event DealSettled(uint256 indexed dealId, bool isEscrow, bool onTime);
    event DealFeePaid(uint256 indexed dealId, address indexed payer, uint256 feeWei);
    event InsuranceClaimPaid(uint256 indexed dealId, address indexed beneficiary, uint256 payoutUsdc);

    constructor(address _usdc, address _treasury, address _ethUsdFeed) {
        require(_ethUsdFeed != address(0), "Oracle feed required");
        usdc = IERC20(_usdc);
        treasury = _treasury == address(0) ? msg.sender : _treasury;
        ethUsdFeed = AggregatorV3Interface(_ethUsdFeed);
    }

    /**
     * @notice 0.1% of the deal amount, converted from USD to wei at the live Chainlink ETH/USD rate.
     * @dev amountUsdc is USDC (6 dp = micro-USD): feeWei = amountUsdc * 1e20 * BPS / (price * 10_000),
     *      where price is USD per 1 ETH with 8 decimals
     *      (e.g. $25,000 deal at ETH $1,689.19 → ≈ 0.0148 ETH).
     *      A stale or broken feed reverts deal creation instead of charging a wrong amount.
     */
    function dealFeeWei(uint256 amountUsdc) public view returns (uint256) {
        (, int256 price,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        require(price > 0, "Bad oracle price");
        require(updatedAt + MAX_PRICE_AGE >= block.timestamp, "Oracle price stale");
        return (amountUsdc * 1e20 * DEAL_FEE_BPS) / (uint256(price) * 10_000);
    }

    /**
     * @notice Type 3: Create Hybrid B2B Trade Deal (Escrow or Net-30/60 Invoice)
     * @dev v17.2: payable — the 0.1% protocol fee is paid in Base ETH here, at the live
     *      Chainlink rate, for BOTH escrow and non-escrow deals. The fee goes to the treasury,
     *      any overpay is refunded to the sender (frontend may add a +1-2% buffer).
     */
    function createDeal(
        address seller,
        address auditor,
        uint256 amountUsdc,
        uint256 netDays,
        bytes32 termsHash,
        bool isEscrowEnabled
    ) external payable returns (uint256 dealId) {
        require(seller != address(0) && seller != msg.sender, "Invalid seller");
        require(amountUsdc > 0, "Invalid amount");

        uint256 feeWei = dealFeeWei(amountUsdc);
        require(msg.value >= feeWei, "Deal fee required (0.1% in Base ETH)");

        dealId = ++nextDealId;
        uint256 due = block.timestamp + (netDays * 1 days);

        // последовательные storage-присваивания вместо большого литерала: обходит "Stack too deep"
        TradeDeal storage d = deals[dealId];
        d.id = dealId;
        d.buyer = msg.sender;
        d.seller = seller;
        d.auditor = auditor;
        d.lender = address(0);
        d.insurer = address(0);
        d.amountUsdc = amountUsdc;
        d.creditPrincipalUsdc = 0;
        d.insuranceCoverageUsdc = 0;
        d.dueTimestamp = due;
        d.termsHash = termsHash;
        d.auditReportHash = bytes32(0);
        d.isEscrowEnabled = isEscrowEnabled;
        d.settledOnTime = false;
        d.status = isEscrowEnabled ? DealStatus.Created : DealStatus.FundedOrActive;

        if (isEscrowEnabled) {
            require(usdc.transferFrom(msg.sender, address(this), amountUsdc), "USDC escrow lock failed");
            d.status = DealStatus.FundedOrActive;
            emit EscrowFunded(dealId, msg.sender, amountUsdc);
        }

        // fee — в казначейство, затем сдача — отправителю; порядок важен для реентрант-безопасности
        if (feeWei > 0) {
            (bool ok, ) = treasury.call{value: feeWei}("");
            require(ok, "Fee transfer failed");
            emit DealFeePaid(dealId, msg.sender, feeWei);
        }
        if (msg.value > feeWei) {
            (bool refunded, ) = msg.sender.call{value: msg.value - feeWei}("");
            require(refunded, "Fee refund failed");
        }

        emit DealCreated(dealId, msg.sender, seller, amountUsdc, isEscrowEnabled, due);
    }

    /**
     * @notice Type 5: Deal-Collateralized Credit Pool
     * @dev Lender funds an Escrow deal on behalf of the buyer, collateralized by the trade receivable.
     */
    function fundDealWithCredit(uint256 dealId) external {
        TradeDeal storage d = deals[dealId];
        require(d.isEscrowEnabled && d.status == DealStatus.Created, "Not eligible for credit funding");

        require(usdc.transferFrom(msg.sender, address(this), d.amountUsdc), "Credit transfer failed");
        d.lender = msg.sender;
        d.creditPrincipalUsdc = d.amountUsdc;
        d.status = DealStatus.FundedOrActive;

        emit CreditProvided(dealId, msg.sender, d.amountUsdc);
    }

    /**
     * @notice Type 6: Attach Cargo / Logistics Insurance Coverage in USDC
     */
    function attachInsurance(uint256 dealId, uint256 coverageUsdc) external {
        TradeDeal storage d = deals[dealId];
        require(d.status == DealStatus.FundedOrActive || d.status == DealStatus.Shipped, "Invalid state");
        require(usdc.transferFrom(msg.sender, address(this), coverageUsdc), "Insurance reserve lock failed");

        d.insurer = msg.sender;
        d.insuranceCoverageUsdc = coverageUsdc;

        emit InsuranceAttached(dealId, msg.sender, coverageUsdc);
    }

    /**
     * @notice Type 4: Independent Validator / Auditor Quality Attestation
     */
    function submitAuditorAttestation(uint256 dealId, bytes32 reportHash) external {
        TradeDeal storage d = deals[dealId];
        require(msg.sender == d.auditor, "Only designated auditor");
        require(d.status == DealStatus.FundedOrActive || d.status == DealStatus.Shipped, "Invalid deal status");

        d.auditReportHash = reportHash;
        d.status = DealStatus.Audited;

        auditedDealsCount[d.buyer]++;
        auditedDealsCount[d.seller]++;

        emit AuditorVerified(dealId, msg.sender, reportHash);
    }

    /**
     * @notice Settle Deal (Releases USDC in Escrow mode, or confirms Net-30/60 invoice payment in Non-Escrow mode)
     */
    function settleDeal(uint256 dealId) external {
        TradeDeal storage d = deals[dealId];
        require(
            d.status == DealStatus.FundedOrActive ||
            d.status == DealStatus.Shipped ||
            d.status == DealStatus.Audited,
            "Deal not active"
        );

        if (d.isEscrowEnabled) {
            require(msg.sender == d.buyer || msg.sender == d.auditor, "Only buyer or auditor can release escrow");
            require(usdc.transfer(d.seller, d.amountUsdc), "Escrow release failed");
            if (d.insuranceCoverageUsdc > 0 && d.insurer != address(0)) {
                require(usdc.transfer(d.insurer, d.insuranceCoverageUsdc), "Insurance reserve return failed");
            }
        } else {
            // Non-Escrow mode: Seller confirms receipt of SEPA / offchain / direct settlement
            require(msg.sender == d.seller, "Only seller can confirm non-escrow invoice settlement");
        }

        bool onTime = block.timestamp <= d.dueTimestamp;
        d.settledOnTime = onTime;
        d.status = DealStatus.Settled;

        completedDealsCount[d.buyer]++;
        completedDealsCount[d.seller]++;
        if (onTime) {
            onTimeInvoiceSettlements[d.buyer]++;
            onTimeInvoiceSettlements[d.seller]++;
        }

        emit DealSettled(dealId, d.isEscrowEnabled, onTime);
    }

    /**
     * @notice Полная запись сделки (замена авто-геттера: 15 полей структуры не собираются в стеке).
     */
    function getDeal(uint256 dealId) external view returns (TradeDeal memory) {
        return deals[dealId];
    }
}
